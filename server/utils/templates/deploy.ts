import type { Sandbox } from '@vercel/sandbox'
import { and, eq, lt, sql } from 'drizzle-orm'
import { PROJECT_ARCHIVE_SCRIPT } from './archive'
import { TEMPLATE_WORKDIR } from './check-scripts'

/** A visitor starts one deploy per cooldown, from any of their previews. Longer than a deploy can run, so two never share a directory. */
export const DEPLOY_COOLDOWN_MS = 5 * 60 * 1000
/** Vercel CLI builds the app in the sandbox: about 40s for a landing page, longer for large apps. */
const DEPLOY_TIMEOUT_MS = 4 * 60 * 1000
/** The CLI's temporary project lives in this directory: deploying again from it updates the same URL and claim link. */
export const DEPLOY_DIR = '/tmp/nuxt-com-deploy'
const DEPLOY_LOG = '/tmp/nuxt-com-deploy.log'

/**
 * Copies the app without the preview's helpers, its dependencies and build output (the files of the ZIP download), then deploys it
 * without a Vercel account. The CLI installs from the snapshot's package store, so the copy never writes to the running app's
 * `node_modules`. Prints the deployment URL, claim link and expiry as JSON. `.vercel/anonymous.json` also holds the project's
 * deploy token, which stays in the sandbox.
 */
function deployScript() {
  return `python3 -c "$1" /tmp/nuxt-com-deploy.zip || exit 1
mkdir -p ${DEPLOY_DIR} && find ${DEPLOY_DIR} -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .vercel -exec rm -rf {} +
python3 -m zipfile -e /tmp/nuxt-com-deploy.zip ${DEPLOY_DIR} && rm -f /tmp/nuxt-com-deploy.zip || exit 1
cd ${DEPLOY_DIR}
NUXT_TELEMETRY_DISABLED=1 timeout ${DEPLOY_TIMEOUT_MS / 1000} npx -y vercel@65 deploy --temporary --yes > /tmp/nuxt-com-deploy.out 2> ${DEPLOY_LOG} || { cat /tmp/nuxt-com-deploy.out >> ${DEPLOY_LOG}; exit 1; }
URL=$(grep -E '^https://' /tmp/nuxt-com-deploy.out | tail -1) node -e "
const { claimUrl, expiresAt } = JSON.parse(require('fs').readFileSync('.vercel/anonymous.json', 'utf8'))
console.log(JSON.stringify({ url: process.env.URL, claimUrl, expiresAt }))"`
}

export interface TemplateDeployment {
  url: string
  claimUrl: string
  expiresAt: number
}

/** Takes the visitor's deploy slot unless they deployed during the cooldown. A single statement, so parallel requests can't both take it. */
export async function reserveDeploy(owner: string) {
  const now = Date.now()
  await db.delete(schema.templateDeploys).where(lt(schema.templateDeploys.deployedAt, new Date(now - DEPLOY_COOLDOWN_MS)))
  const reserved = await db.all(sql`
    INSERT INTO template_deploys (owner, deployed_at) VALUES (${owner}, ${now})
    ON CONFLICT (owner) DO UPDATE SET deployed_at = excluded.deployed_at
    WHERE template_deploys.deployed_at <= ${now - DEPLOY_COOLDOWN_MS}
    RETURNING owner`)
  if (reserved.length) return
  const [row] = await db.select().from(schema.templateDeploys).where(eq(schema.templateDeploys.owner, owner)).limit(1)
  const wait = Math.max(1, Math.ceil(((row?.deployedAt.getTime() ?? now) + DEPLOY_COOLDOWN_MS - now) / 60_000))
  throw createError({ statusCode: 429, message: `You can deploy again in ${wait} minute${wait === 1 ? '' : 's'}.` })
}

/** Gives the slot back after a failed deploy, so the visitor can fix the app and try again right away. */
export async function releaseDeploy(owner: string) {
  await db.delete(schema.templateDeploys).where(eq(schema.templateDeploys.owner, owner))
}

/**
 * Keeps the preview running until the deploy is done or timed out, and its preview slot with it.
 * Returns when the sandbox stops now, for the page's countdown.
 */
export async function keepPreviewForDeploy(owner: string, sandbox: Sandbox) {
  const needed = Date.now() + DEPLOY_TIMEOUT_MS + 30_000
  // An unknown expiry is treated as now: the extension then covers the whole deploy.
  const stopsAt = sandbox.expiresAt?.getTime() ?? Date.now()
  if (stopsAt >= needed) return stopsAt
  await sandbox.extendTimeout(needed - stopsAt)
  await db.update(schema.templatePreviews)
    .set({ expiresAt: new Date(needed + 60_000) })
    .where(and(eq(schema.templatePreviews.owner, owner), eq(schema.templatePreviews.id, sandbox.name)))
  return needed
}

export async function deployPreview(sandbox: Sandbox): Promise<TemplateDeployment> {
  const result = await sandbox.runCommand({
    cmd: 'bash', args: ['-c', deployScript(), 'deploy', PROJECT_ARCHIVE_SCRIPT], cwd: TEMPLATE_WORKDIR,
    // The sandbox kills the command at the same bound, so a retry never clears the deploy directory under a deploy still running.
    timeoutMs: DEPLOY_TIMEOUT_MS + 30_000,
    signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS + 30_000)
  })
  const output = (await result.stdout()).trim()
  if (result.exitCode !== 0) {
    const log = await sandbox.runCommand({ cmd: 'tail', args: ['-c', '4000', DEPLOY_LOG], signal: AbortSignal.timeout(10_000) })
      .then(command => command.stdout()).catch(() => '')
    console.error('[templates] deploy failed', log)
    throw createError({ statusCode: 502, message: 'The deploy failed. Vercel could not build this version of the app.' })
  }
  let deployment: Partial<TemplateDeployment> = {}
  try {
    deployment = JSON.parse(output.split('\n').pop()!)
  } catch {
    // Not JSON: reported below as a deploy without a claim link.
  }
  if (!deployment.url || !deployment.claimUrl?.startsWith('https://vercel.com/') || !deployment.expiresAt) {
    console.error('[templates] deploy returned no claim link', output.slice(-2000))
    throw createError({ statusCode: 502, message: 'The deploy finished without a claim link.' })
  }
  return deployment as TemplateDeployment
}
