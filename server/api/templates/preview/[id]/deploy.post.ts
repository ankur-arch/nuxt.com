import type { PreviewDeployEvent } from '#shared/types'

/**
 * Deploys the visitor's live preview, with their edits, to Vercel without an account. They claim it to keep it.
 * Streams NDJSON `PreviewDeployEvent`s: the deploy takes about a minute.
 */
export default defineEventHandler(async (event) => {
  const owner = await getRateLimitPrincipalId(event)
  const sandbox = owner ? await getPreviewSandbox(getRouterParam(event, 'id')!, owner) : null
  if (!owner || sandbox?.status !== 'running') {
    throw createError({ statusCode: 404, message: 'This preview has stopped.' })
  }
  await reserveDeploy(owner)

  setResponseHeaders(event, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
  const encoder = new TextEncoder()
  let cancelled = false
  return new ReadableStream({
    async start(controller) {
      const send = (data: PreviewDeployEvent) => {
        if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`))
      }
      try {
        send({ type: 'started', stopsAt: await keepPreviewForDeploy(owner, sandbox) })
        // The page starts live editing again once the deploy ends.
        await pauseDevServer(sandbox)
        send({ type: 'ready', ...await deployPreview(sandbox) })
      } catch (error) {
        await releaseDeploy(owner).catch(() => {})
        if (!isError(error)) console.error('[templates] deploy failed', error)
        send({ type: 'error', message: isError(error) && error.message ? error.message : 'The deploy failed.' })
      } finally {
        await resumeDevServer(sandbox).catch(() => {})
        if (!cancelled) controller.close()
      }
    },
    cancel() {
      cancelled = true
    }
  })
})
