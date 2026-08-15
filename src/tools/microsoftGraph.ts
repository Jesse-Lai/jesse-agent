import type { Tool } from '../types.js'
import {
  getMailMessage,
  getMicrosoftGraphProfile,
  getTeamsChatMessages,
  graphGet,
  listMailMessages,
  listTeamsChats,
  searchMailMessages,
  searchTeamsMessages,
} from '../connectors/microsoftGraph.js'

export const microsoftGraphTool: Tool = {
  name: 'microsoft_graph',

  description:
    'Read Microsoft 365 work data through Microsoft Graph using the current local auth context. ' +
    'Use this for Teams chat summaries, work feedback, Outlook/M365 Graph reads, and user profile checks. ' +
    'Available actions: get_profile, list_teams_chats, get_teams_chat_messages, search_teams_messages, ' +
    'list_mail_messages, search_mail_messages, get_mail_message, graph_get. ' +
    'For Teams summaries, first list_teams_chats when you need the chat id/name, then call get_teams_chat_messages with chatName or chatId and date YYYY-MM-DD. ' +
    'For Outlook email, use list_mail_messages with an optional date or unreadOnly filter, search_mail_messages for keywords, and get_mail_message for the full body. ' +
    'This tool is read-only and never returns the underlying access token.',

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'get_profile',
          'list_teams_chats',
          'get_teams_chat_messages',
          'search_teams_messages',
          'list_mail_messages',
          'search_mail_messages',
          'get_mail_message',
          'graph_get',
        ],
        description: 'Read action to perform.',
      },
      chatId: { type: 'string', description: 'Teams chat id for get_teams_chat_messages.' },
      chatName: { type: 'string', description: 'Teams chat display name/topic, such as MSAI STCA Design.' },
      date: { type: 'string', description: 'Local calendar date to fetch, formatted YYYY-MM-DD.' },
      startDateTime: { type: 'string', description: 'Inclusive ISO timestamp for a custom message range.' },
      endDateTime: { type: 'string', description: 'Exclusive ISO timestamp for a custom message range.' },
      query: { type: 'string', description: 'Search text for search_teams_messages or search_mail_messages.' },
      recencyDays: { type: 'number', description: 'How many recent days to scan for search_teams_messages. Default 7.' },
      folder: { type: 'string', description: 'Outlook mail folder id or well-known name for list_mail_messages. Default inbox.' },
      messageId: { type: 'string', description: 'Outlook message id for get_mail_message.' },
      unreadOnly: { type: 'boolean', description: 'When true, list only unread Outlook messages.' },
      top: { type: 'number', description: 'Maximum number of results to return.' },
      path: { type: 'string', description: 'Microsoft Graph relative path or graph.microsoft.com URL for graph_get.' },
    },
    required: ['action'],
  },

  isReadOnly: true,

  async execute(args) {
    const action = String(args.action ?? '')
    if (action === 'get_profile') return stringify(await getMicrosoftGraphProfile())
    if (action === 'list_teams_chats') return stringify(await listTeamsChats(readNumber(args.top, 20)))
    if (action === 'get_teams_chat_messages') {
      return stringify(await getTeamsChatMessages({
        chatId: readString(args.chatId),
        chatName: readString(args.chatName),
        date: readString(args.date),
        startDateTime: readString(args.startDateTime),
        endDateTime: readString(args.endDateTime),
        top: readNumber(args.top, undefined),
      }))
    }
    if (action === 'search_teams_messages') {
      return stringify(await searchTeamsMessages({
        query: readRequiredString(args.query, 'query'),
        chatName: readString(args.chatName),
        recencyDays: readNumber(args.recencyDays, undefined),
        top: readNumber(args.top, undefined),
      }))
    }
    if (action === 'list_mail_messages') {
      return stringify(await listMailMessages({
        folder: readString(args.folder),
        date: readString(args.date),
        startDateTime: readString(args.startDateTime),
        endDateTime: readString(args.endDateTime),
        unreadOnly: readBoolean(args.unreadOnly),
        top: readNumber(args.top, undefined),
      }))
    }
    if (action === 'search_mail_messages') {
      return stringify(await searchMailMessages({
        query: readRequiredString(args.query, 'query'),
        top: readNumber(args.top, undefined),
      }))
    }
    if (action === 'get_mail_message') {
      return stringify(await getMailMessage(readRequiredString(args.messageId, 'messageId')))
    }
    if (action === 'graph_get') return stringify(await graphGet(readRequiredString(args.path, 'path')))
    throw new Error(`Unknown microsoft_graph action: ${action}`)
  },
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readRequiredString(value: unknown, name: string): string {
  const text = readString(value)
  if (!text) throw new Error(`${name} is required`)
  return text
}

function readNumber(value: unknown, fallback: number): number
function readNumber(value: unknown, fallback: undefined): number | undefined
function readNumber(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
