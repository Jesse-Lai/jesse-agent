import { stdout } from 'node:process'
import { listSessionSummaries, SessionTranscript } from './session.js'
import { generateSessionTitle } from './sessionTitle.js'

const sessions = (await listSessionSummaries(500))
  .filter(session => !session.hasPersistedTitle && session.firstUserMessage)

if (sessions.length === 0) {
  stdout.write('All sessions already have generated titles.\n')
} else {
  let nextIndex = 0
  let completed = 0

  async function worker(): Promise<void> {
    while (nextIndex < sessions.length) {
      const session = sessions[nextIndex++]
      if (!session?.firstUserMessage) continue
      const title = await generateSessionTitle(
        session.firstUserMessage,
        AbortSignal.timeout(15_000),
      )
      if (!title) {
        stdout.write(`Skipped ${session.id}: title generation failed.\n`)
        continue
      }
      await new SessionTranscript(session.id, session.filePath).appendTitle(title, 'ai')
      completed += 1
      stdout.write(`${session.id}: ${title}\n`)
    }
  }

  await Promise.all([worker(), worker()])
  stdout.write(`Generated ${completed}/${sessions.length} session titles.\n`)
}
