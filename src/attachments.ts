import { Buffer } from 'node:buffer'

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number]

export const MAX_IMAGE_ATTACHMENT_BYTES = 16 * 1024 * 1024
export const MAX_MESSAGE_IMAGE_ATTACHMENTS = 8

export interface MessageImageAttachment {
  type: 'image'
  mimeType: ImageMimeType
  /** Content-addressed filename inside the Session's asset directory. */
  assetId?: string
  /** Present only while a message is in memory or crossing an input/event boundary. */
  dataURL?: string
  /** HTTP path supplied to UI clients when reading a persisted Session. */
  url?: string
  name?: string
  byteLength?: number
  width?: number
  height?: number
  source?: 'user' | 'generated'
}

export type MessageAttachment = MessageImageAttachment

export interface ParsedImageDataURL {
  mimeType: ImageMimeType
  bytes: Buffer
  dataURL: string
}

export function parseImageDataURL(value: unknown): ParsedImageDataURL {
  if (typeof value !== 'string') throw new Error('image attachment dataURL must be a string')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value)
  if (!match) throw new Error('image attachment must be a PNG, JPEG, or WebP data URL')

  const mimeType = match[1]!.toLowerCase() as ImageMimeType
  const payload = match[2]!.replace(/[\r\n]/g, '')
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length === 0) throw new Error('image attachment is empty')
  if (bytes.length > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(`image attachment exceeds ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024} MB`)
  }

  return {
    mimeType,
    bytes,
    dataURL: `data:${mimeType};base64,${bytes.toString('base64')}`,
  }
}

export function normalizeMessageAttachments(value: unknown): MessageAttachment[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('attachments must be an array')
  if (value.length > MAX_MESSAGE_IMAGE_ATTACHMENTS) {
    throw new Error(`a message can include at most ${MAX_MESSAGE_IMAGE_ATTACHMENTS} images`)
  }

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`attachment ${index + 1} must be an object`)
    }
    const record = candidate as Record<string, unknown>
    if (record.type !== 'image') throw new Error(`attachment ${index + 1} has unsupported type`)
    const parsed = parseImageDataURL(record.dataURL)
    return {
      type: 'image',
      mimeType: parsed.mimeType,
      dataURL: parsed.dataURL,
      byteLength: parsed.bytes.length,
      name: optionalDisplayName(record.name),
      width: optionalPositiveInteger(record.width),
      height: optionalPositiveInteger(record.height),
      source: record.source === 'generated' ? 'generated' : 'user',
    }
  })
}

export function attachmentDataURL(attachment: MessageAttachment): string | undefined {
  if (!attachment.dataURL) return undefined
  return parseImageDataURL(attachment.dataURL).dataURL
}

export function persistedAttachment(attachment: MessageAttachment): MessageAttachment {
  const { dataURL: _dataURL, url: _url, ...metadata } = attachment
  return metadata
}

export function imageExtension(mimeType: ImageMimeType): 'png' | 'jpg' | 'webp' {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

export function isValidAssetId(value: string): boolean {
  return /^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(value)
}

export function imageAttachmentLabel(attachment: MessageAttachment): string {
  return attachment.name?.trim() || (attachment.source === 'generated' ? 'Generated image' : 'Attached image')
}

function optionalDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return normalized ? normalized.slice(0, 160) : undefined
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(100_000, Math.round(value))
}
