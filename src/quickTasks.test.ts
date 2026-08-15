import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseQuickTaskInput } from './quickTasks.js'

describe('parseQuickTaskInput', () => {
  it('accepts text transforms and trims their context', () => {
    const input = parseQuickTaskInput({
      action: 'polish',
      selectedText: '  原始文案  ',
      sourceApp: '  Teams  ',
    })
    assert.equal(input.action, 'polish')
    assert.equal(input.selectedText, '原始文案')
    assert.equal(input.sourceApp, 'Teams')
  })

  it('allows a question without selected text', () => {
    const input = parseQuickTaskInput({ action: 'ask', instruction: '解释这个概念' })
    assert.equal(input.instruction, '解释这个概念')
    assert.equal(input.selectedText, undefined)
  })

  it('allows a question with a screenshot attachment', () => {
    const input = parseQuickTaskInput({
      action: 'ask',
      instruction: '这个错误应该怎么解决？',
      imageDataURL: 'data:image/png;base64,AA==',
    })
    assert.equal(input.action, 'ask')
    assert.equal(input.instruction, '这个错误应该怎么解决？')
    assert.match(input.imageDataURL ?? '', /^data:image\/png/)
  })

  it('requires selected text for transform and image actions', () => {
    for (const action of ['polish', 'translate', 'image']) {
      assert.throws(() => parseQuickTaskInput({ action }), /requires selectedText/)
    }
    assert.throws(
      () => parseQuickTaskInput({ action: 'summarize' }),
      /requires selectedText or imageDataURL/,
    )
    const visualSummary = parseQuickTaskInput({
      action: 'summarize',
      imageDataURL: 'data:image/png;base64,AA==',
    })
    assert.equal(visualSummary.action, 'summarize')
    assert.match(visualSummary.imageDataURL ?? '', /^data:image\/png/)
  })

  it('accepts multimodal image data and rejects unsupported payloads', () => {
    const valid = parseQuickTaskInput({
      action: 'screenshot',
      imageDataURL: 'data:image/png;base64,AA==',
    })
    assert.match(valid.imageDataURL ?? '', /^data:image\/png/)
    assert.throws(
      () => parseQuickTaskInput({ action: 'screenshot', imageDataURL: 'data:text/plain;base64,AA==' }),
      /PNG, JPEG, or WebP/,
    )
  })
})
