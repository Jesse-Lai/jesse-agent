import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer } from '../src/components/Composer.tsx'
import { Conversation } from '../src/components/Conversation.tsx'
import type { ComposerImageAttachment, ConversationItem } from '../src/types.ts'

const INLINE_IMAGE = 'data:image/png;base64,AA=='

test('composer renders selected image previews and allows an image-only submit', () => {
  const attachment: ComposerImageAttachment = {
    id: 'image-1',
    type: 'image',
    mimeType: 'image/png',
    dataURL: INLINE_IMAGE,
    name: 'cat.png',
    byteLength: 1,
    source: 'user',
  }

  const html = renderToStaticMarkup(
    <Composer
      value=""
      running={false}
      queuedPrompts={[]}
      queueStatus=""
      maxQueuedPrompts={5}
      queueingEnabled
      activeProject="/workspace"
      permissionMode="default"
      annotations={[]}
      attachments={[attachment]}
      pendingApproval={null}
      onChange={() => {}}
      onPermissionModeChange={() => {}}
      onApproval={async () => {}}
      onRemoveAnnotation={() => {}}
      onAddAttachments={() => {}}
      onRemoveAttachment={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
      onQueue={() => {}}
      onQueuedEdit={() => {}}
      onQueuedDelete={() => {}}
      onQueuedSteer={() => {}}
      onTurnOffQueueing={() => {}}
    />,
  )

  assert.match(html, /aria-label="Attached images"/)
  assert.match(html, /alt="cat.png"/)
  assert.doesNotMatch(html, /data-squircle-ignore/)
  assert.match(html, /aria-label="Send"/)
  assert.doesNotMatch(html, /aria-label="Send"[^>]*disabled/)
})

test('conversation renders user uploads and URL-backed agent images', () => {
  const items: ConversationItem[] = [
    {
      id: 'user-1',
      type: 'message',
      role: 'user',
      text: 'Compare these',
      createdAt: '2026-08-10T10:00:00.000Z',
      canEdit: true,
      attachments: [{
        id: 'upload-1',
        type: 'image',
        mimeType: 'image/png',
        dataURL: INLINE_IMAGE,
        name: 'upload.png',
        source: 'user',
      }],
    },
    {
      id: 'assistant-1',
      type: 'message',
      role: 'assistant',
      text: 'Here is the generated image.',
      createdAt: '2026-08-10T10:00:01.000Z',
      attachments: [{
        type: 'image',
        mimeType: 'image/png',
        assetId: 'generated.png',
        url: '/api/session/assets/session/generated.png',
        name: 'Generated image.png',
        source: 'generated',
      }],
    },
  ]

  const html = renderToStaticMarkup(
    <Conversation
      items={items}
      onCopyMessage={() => {}}
      onEditMessage={() => {}}
      onAddSelectionToChat={() => {}}
    />,
  )

  assert.match(html, /src="data:image\/png;base64,AA=="/)
  assert.match(html, /Compare these/)
  assert.match(html, /src="\/api\/session\/assets\/session\/generated.png"/)
  assert.match(html, /Here is the generated image\./)
  assert.match(html, /fluent-icon icon-copy/)
  assert.match(html, /fluent-icon icon-edit/)
  assert.doesNotMatch(html, /copy-icon/)
})
