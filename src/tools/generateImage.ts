import { generateImage } from '../imageGeneration.js'
import { parseImageDataURL } from '../attachments.js'
import type { Tool } from '../types.js'

const allowedSizes = new Set(['1024x1024', '1024x1536', '1536x1024'])

export const generateImageTool: Tool = {
  name: 'generate_image',
  description: [
    'Generate a new bitmap image from a detailed visual prompt.',
    'Use this whenever the user asks to create, draw, illustrate, or generate an image.',
    'The generated image is attached to the assistant message automatically; do not encode image bytes in your text response.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'A complete visual description including subject, composition, style, lighting, and any important constraints.',
      },
      size: {
        type: 'string',
        enum: ['1024x1024', '1024x1536', '1536x1024'],
        description: 'Output aspect ratio. Use landscape 1536x1024 by default.',
      },
    },
    required: ['prompt'],
  },
  // Generation has no filesystem or external-account side effects. It may run
  // without the write-action approval flow, just like a model response.
  isReadOnly: true,
  async execute(args, context) {
    const prompt = String(args.prompt ?? '').trim()
    const requestedSize = typeof args.size === 'string' && allowedSizes.has(args.size)
      ? args.size as '1024x1024' | '1024x1536' | '1536x1024'
      : '1536x1024'
    const generated = await generateImage({ prompt, size: requestedSize, signal: context?.signal })
    const parsed = parseImageDataURL(generated.dataURL)
    return {
      content: generated.revisedPrompt
        ? `Image generated successfully. Revised prompt: ${generated.revisedPrompt}`
        : 'Image generated successfully and attached to the response.',
      attachments: [{
        type: 'image',
        mimeType: parsed.mimeType,
        dataURL: parsed.dataURL,
        byteLength: parsed.bytes.length,
        name: 'Generated image.png',
        source: 'generated',
      }],
    }
  },
}
