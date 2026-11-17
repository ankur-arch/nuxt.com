import type { Sandbox } from '@vercel/sandbox'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createError } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEPLOY_DIR, deployPreview } from '../../server/utils/templates/deploy'

// Stands in for `npx vercel deploy --temporary`: like the real CLI, it keeps its project in `.vercel/anonymous.json` and prints the URL last.
const FAKE_NPX = `#!/bin/sh
[ "$FAIL" = 1 ] && { echo "Error: build failed" >&2; exit 1; }
ls -A > "$LISTING"
mkdir -p .vercel
[ -f .vercel/anonymous.json ] || echo '{"projectId":"prj_'$(date +%s%N)'","token":"secret-deploy-token","claimUrl":"https://vercel.com/claim-deployment?code=abc","expiresAt":1794914204624}' > .vercel/anonymous.json
mkdir -p node_modules && echo installed > node_modules/marker
echo "Running pnpm run build"
printf 'https://zippy-kazoo.tmp.now'
`

describe('deploying a live preview', () => {
  let app: string, bin: string
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, LISTING: join(bin, 'listing'), ...extra })
  const sandbox = (extra?: Record<string, string>) => ({
    runCommand: vi.fn(async ({ cmd, args }: { cmd: string, args: string[] }) => {
      try {
        const stdout = execFileSync(cmd, args, { cwd: app, env: env(extra), encoding: 'utf8' })
        return { exitCode: 0, stdout: async () => stdout }
      } catch (error: any) {
        return { exitCode: error.status, stdout: async () => error.stdout ?? '' }
      }
    })
  }) as unknown as Sandbox

  beforeEach(() => {
    vi.stubGlobal('createError', createError)
    rmSync(DEPLOY_DIR, { recursive: true, force: true })
    app = mkdtempSync(join(tmpdir(), 'template-app-'))
    bin = mkdtempSync(join(tmpdir(), 'fake-npx-'))
    writeFileSync(join(bin, 'npx'), FAKE_NPX)
    chmodSync(join(bin, 'npx'), 0o755)
    const files = {
      'app/app.vue': '<template><h1>Edited by Nuxi</h1></template>',
      'app/pages/about.vue': '<template>About</template>',
      'package.json': '{}',
      'app/plugins/nuxt-com-preview.client.js': 'bridge',
      'node_modules/nuxt/index.js': 'dependency',
      '.output/server/index.mjs': 'build',
      '.vercel/project.json': '{"projectId":"the-template-authors"}'
    }
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(app, path, '..'), { recursive: true })
      writeFileSync(join(app, path), content)
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of [app, bin, DEPLOY_DIR]) rmSync(dir, { recursive: true, force: true })
  })

  it('deploys a clean copy of the edited app and returns its claim link, never its deploy token', async () => {
    const result = await deployPreview(sandbox())
    expect(result).toEqual({ url: 'https://zippy-kazoo.tmp.now', claimUrl: 'https://vercel.com/claim-deployment?code=abc', expiresAt: 1794914204624 })
    expect(JSON.stringify(result)).not.toContain('secret-deploy-token')
    // What the CLI saw: no preview bridge, dependencies, build output or the template's own Vercel project.
    expect(readFileSync(join(bin, 'listing'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['app', 'package.json'])
    expect(existsSync(join(DEPLOY_DIR, 'app/plugins/nuxt-com-preview.client.js'))).toBe(false)
    expect(readFileSync(join(DEPLOY_DIR, 'app/app.vue'), 'utf8')).toContain('Edited by Nuxi')
    expect(existsSync(join(app, 'node_modules/marker'))).toBe(false)
  })

  it('redeploys the latest edits to the same temporary project', async () => {
    await deployPreview(sandbox())
    const project = () => JSON.parse(readFileSync(join(DEPLOY_DIR, '.vercel/anonymous.json'), 'utf8')).projectId
    const first = project()
    rmSync(join(app, 'app/pages/about.vue'))
    writeFileSync(join(app, 'app/app.vue'), '<template><h1>Edited again</h1></template>')
    await deployPreview(sandbox())
    expect(existsSync(join(DEPLOY_DIR, 'app/pages/about.vue'))).toBe(false)
    expect(readFileSync(join(DEPLOY_DIR, 'app/app.vue'), 'utf8')).toContain('Edited again')
    expect(project()).toBe(first)
  })

  it('reports a failed build without upstream details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(deployPreview(sandbox({ FAIL: '1' }))).rejects.toMatchObject({ statusCode: 502, message: 'The deploy failed. Vercel could not build this version of the app.' })
  })
})
