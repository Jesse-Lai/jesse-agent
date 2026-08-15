import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'
const OUTLOOK_BASE_URL = 'https://outlook.office.com/api/v2.0'
const OUTLOOK_URL_MARKERS = ['outlook.office.com', 'outlook.cloud.microsoft'] as const
const TOKEN_CHUNK_SIZE = 500
const TOKEN_CHUNKS = 24
const APPLESCRIPT_TIMEOUT_MS = 5_000
const BROWSER_TOKEN_REFRESH_TIMEOUT_MS = 30_000
const MICROSOFT_365_CLIENT_ID = '9199bf20-a13f-4107-85dc-02114787ef48'
const BROWSER_REFRESH_STATE = '__jesseMicrosoftTokenRefresh'
const GRAPH_REQUEST_TIMEOUT_MS = 120_000
const GRAPH_MAX_ATTEMPTS = 4
const GRAPH_MAX_RESPONSE_BYTES = 25 * 1024 * 1024
const TOKEN_FALLBACK_CACHE_MS = 45 * 60 * 1_000
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1_000
const MAIL_SUMMARY_SELECT = [
  'id',
  'subject',
  'receivedDateTime',
  'sentDateTime',
  'from',
  'toRecipients',
  'ccRecipients',
  'bodyPreview',
  'isRead',
  'hasAttachments',
  'webLink',
].join(',')
const OUTLOOK_MAIL_SUMMARY_SELECT = [
  'Id',
  'Subject',
  'ReceivedDateTime',
  'SentDateTime',
  'From',
  'ToRecipients',
  'CcRecipients',
  'BodyPreview',
  'IsRead',
  'HasAttachments',
  'WebLink',
].join(',')

type MicrosoftTokenAudience = 'graph' | 'outlook'

const microsoftTokenCache: Partial<Record<MicrosoftTokenAudience, { token: string; expiresAt: number }>> = {}
const microsoftTokenRefreshes: Partial<Record<MicrosoftTokenAudience, Promise<string>>> = {}

export interface GraphProfile {
  displayName?: string
  mail?: string
  userPrincipalName?: string
  jobTitle?: string
  department?: string
}

export interface GraphChatPreview {
  id: string
  topic: string
  chatType: string
  lastMessageTime: string
  sender: string
  preview: string
}

export interface GraphChatMessageSummary {
  id: string
  time: string
  sender: string
  content: string
}

export interface GraphMailMessageSummary {
  id: string
  subject: string
  receivedDateTime: string
  sentDateTime: string
  sender: string
  senderAddress: string
  toRecipients: string[]
  ccRecipients: string[]
  preview: string
  isRead: boolean
  hasAttachments: boolean
  webLink: string
}

export interface GraphMailMessageDetail extends GraphMailMessageSummary {
  body: string
  bodyContentType: string
}

interface GraphChat {
  id?: string
  topic?: string | null
  chatType?: string
  lastMessagePreview?: {
    createdDateTime?: string
    from?: GraphMessageFrom
    body?: { content?: string }
  }
}

interface GraphChatMessage {
  id?: string
  createdDateTime?: string
  messageType?: string
  from?: GraphMessageFrom
  body?: { content?: string }
}

interface GraphMessageFrom {
  user?: { displayName?: string }
  application?: { displayName?: string }
}

interface GraphEmailAddress {
  emailAddress?: {
    name?: string
    address?: string
  }
  EmailAddress?: {
    Name?: string
    Address?: string
  }
}

interface GraphMailMessage {
  id?: string
  Id?: string
  subject?: string
  Subject?: string
  receivedDateTime?: string
  ReceivedDateTime?: string
  sentDateTime?: string
  SentDateTime?: string
  from?: GraphEmailAddress
  From?: GraphEmailAddress
  sender?: GraphEmailAddress
  Sender?: GraphEmailAddress
  toRecipients?: GraphEmailAddress[]
  ToRecipients?: GraphEmailAddress[]
  ccRecipients?: GraphEmailAddress[]
  CcRecipients?: GraphEmailAddress[]
  bodyPreview?: string
  BodyPreview?: string
  body?: {
    contentType?: string
    content?: string
  }
  Body?: {
    ContentType?: string
    Content?: string
  }
  isRead?: boolean
  IsRead?: boolean
  hasAttachments?: boolean
  HasAttachments?: boolean
  webLink?: string
  WebLink?: string
}

interface GraphCollection<T> {
  value?: T[]
  '@odata.nextLink'?: string
}

interface GraphGetOptions {
  headers?: Record<string, string>
  maxAttempts?: number
}

interface GraphHttpResponse {
  statusCode: number
  statusMessage: string
  retryAfter?: string
  data: unknown
}

export async function getMicrosoftGraphProfile(): Promise<GraphProfile> {
  return await graphGet<GraphProfile>('/me')
}

export async function listTeamsChats(top = 20): Promise<GraphChatPreview[]> {
  const limit = clampInteger(top, 1, 50)
  const data = await graphGet<GraphCollection<GraphChat>>(
    `/me/chats?$top=${limit}&$orderby=lastMessagePreview/createdDateTime%20desc&$expand=lastMessagePreview`,
  )

  return (data.value ?? []).flatMap(chat => {
    if (!chat.id) return []
    const preview = chat.lastMessagePreview
    return [{
      id: chat.id,
      topic: chat.topic || '1:1 Chat',
      chatType: chat.chatType || '',
      lastMessageTime: preview?.createdDateTime || '',
      sender: displaySender(preview?.from),
      preview: stripHtml(preview?.body?.content || '').slice(0, 500),
    }]
  })
}

export async function getTeamsChatMessages(options: {
  chatId?: string
  chatName?: string
  date?: string
  startDateTime?: string
  endDateTime?: string
  top?: number
}): Promise<{
  chat: { id: string; topic: string; chatType: string }
  range?: { startDateTime: string; endDateTime: string; timezone: 'local' }
  count: number
  messages: GraphChatMessageSummary[]
}> {
  const chat = await resolveChat(options.chatId, options.chatName)
  const range = resolveDateRange(options.date, options.startDateTime, options.endDateTime)
  const top = clampInteger(options.top ?? (range ? 500 : 50), 1, 500)
  const messages: GraphChatMessageSummary[] = []
  const startMs = range ? Date.parse(range.startDateTime) : undefined
  const endMs = range ? Date.parse(range.endDateTime) : undefined

  let next = `/me/chats/${encodeURIComponent(chat.id)}/messages?$top=50`
  let pages = 0
  while (next && pages < 30 && messages.length < top) {
    pages += 1
    const data = await graphGet<GraphCollection<GraphChatMessage>>(next)
    const pageMessages = data.value ?? []

    for (const message of pageMessages) {
      if (message.messageType === 'systemEventMessage') continue
      const createdAt = message.createdDateTime ? Date.parse(message.createdDateTime) : Number.NaN
      if (!Number.isFinite(createdAt)) continue
      if (startMs !== undefined && createdAt < startMs) continue
      if (endMs !== undefined && createdAt >= endMs) continue
      const content = stripHtml(message.body?.content || '')
      if (!content) continue
      messages.push({
        id: message.id || '',
        time: message.createdDateTime || '',
        sender: displaySender(message.from),
        content: content.slice(0, 2_000),
      })
      if (messages.length >= top) break
    }

    const oldest = oldestMessageTime(pageMessages)
    if (startMs !== undefined && oldest !== null && oldest < startMs) break
    next = data['@odata.nextLink'] || ''
  }

  messages.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  return {
    chat: { id: chat.id, topic: chat.topic, chatType: chat.chatType },
    ...(range ? { range: { ...range, timezone: 'local' as const } } : {}),
    count: messages.length,
    messages,
  }
}

export async function searchTeamsMessages(options: {
  query: string
  chatName?: string
  recencyDays?: number
  top?: number
}): Promise<{
  query: string
  count: number
  matches: Array<GraphChatMessageSummary & { chatId: string; chatTopic: string }>
}> {
  const query = options.query.trim().toLowerCase()
  if (!query) throw new Error('query is required for search_teams_messages')

  const cutoff = Date.now() - clampInteger(options.recencyDays ?? 7, 1, 90) * 24 * 60 * 60 * 1000
  const top = clampInteger(options.top ?? 25, 1, 100)
  const chats = options.chatName
    ? [await resolveChat(undefined, options.chatName)]
    : (await listTeamsChats(30)).map(chat => ({ id: chat.id, topic: chat.topic, chatType: chat.chatType }))
  const matches: Array<GraphChatMessageSummary & { chatId: string; chatTopic: string }> = []

  for (const chat of chats) {
    if (matches.length >= top) break
    let next = `/me/chats/${encodeURIComponent(chat.id)}/messages?$top=30`
    let pages = 0
    while (next && pages < 5 && matches.length < top) {
      pages += 1
      const data = await graphGet<GraphCollection<GraphChatMessage>>(next)
      const pageMessages = data.value ?? []
      for (const message of pageMessages) {
        const createdAt = message.createdDateTime ? Date.parse(message.createdDateTime) : Number.NaN
        if (Number.isFinite(createdAt) && createdAt < cutoff) continue
        const content = stripHtml(message.body?.content || '')
        if (!content.toLowerCase().includes(query)) continue
        matches.push({
          chatId: chat.id,
          chatTopic: chat.topic,
          id: message.id || '',
          time: message.createdDateTime || '',
          sender: displaySender(message.from),
          content: content.slice(0, 2_000),
        })
        if (matches.length >= top) break
      }
      const oldest = oldestMessageTime(pageMessages)
      if (oldest !== null && oldest < cutoff) break
      next = data['@odata.nextLink'] || ''
    }
  }

  matches.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  return { query: options.query, count: matches.length, matches }
}

export async function listMailMessages(options: {
  folder?: string
  date?: string
  startDateTime?: string
  endDateTime?: string
  unreadOnly?: boolean
  top?: number
} = {}): Promise<{
  folder: string
  range?: { startDateTime: string; endDateTime: string; timezone: 'local' }
  count: number
  messages: GraphMailMessageSummary[]
}> {
  const folder = options.folder?.trim() || 'inbox'
  const range = resolveDateRange(options.date, options.startDateTime, options.endDateTime)
  const params = new URLSearchParams({
    '$top': String(clampInteger(options.top ?? 25, 1, 100)),
    '$orderby': 'receivedDateTime desc',
    '$select': MAIL_SUMMARY_SELECT,
  })
  const filters: string[] = []
  if (range) {
    filters.push(`receivedDateTime ge ${range.startDateTime}`)
    filters.push(`receivedDateTime lt ${range.endDateTime}`)
  }
  if (options.unreadOnly) filters.push('isRead eq false')
  if (filters.length > 0) params.set('$filter', filters.join(' and '))

  const outlookParams = new URLSearchParams({
    '$top': String(clampInteger(options.top ?? 25, 1, 100)),
    '$orderby': 'ReceivedDateTime desc',
    '$select': OUTLOOK_MAIL_SUMMARY_SELECT,
  })
  const outlookFilters: string[] = []
  if (range) {
    outlookFilters.push(`ReceivedDateTime ge ${range.startDateTime}`)
    outlookFilters.push(`ReceivedDateTime lt ${range.endDateTime}`)
  }
  if (options.unreadOnly) outlookFilters.push('IsRead eq false')
  if (outlookFilters.length > 0) outlookParams.set('$filter', outlookFilters.join(' and '))

  const data = await mailGet<GraphCollection<GraphMailMessage>>(
    `/me/mailFolders/${encodeURIComponent(folder)}/messages?${params.toString()}`,
    `/me/mailFolders/${encodeURIComponent(folder)}/messages?${outlookParams.toString()}`,
  )
  const messages = (data.value ?? []).flatMap(message => mailMessageId(message) ? [mailSummary(message)] : [])
  return {
    folder,
    ...(range ? { range: { ...range, timezone: 'local' as const } } : {}),
    count: messages.length,
    messages,
  }
}

export async function searchMailMessages(options: {
  query: string
  top?: number
}): Promise<{
  query: string
  count: number
  messages: GraphMailMessageSummary[]
}> {
  const query = options.query.trim()
  if (!query) throw new Error('query is required for search_mail_messages')
  const escapedQuery = query.replaceAll('"', '\\"')
  const params = new URLSearchParams({
    '$search': `"${escapedQuery}"`,
    '$top': String(clampInteger(options.top ?? 25, 1, 100)),
    '$select': MAIL_SUMMARY_SELECT,
  })
  const outlookParams = new URLSearchParams({
    '$search': `"${escapedQuery}"`,
    '$top': String(clampInteger(options.top ?? 25, 1, 100)),
    '$select': OUTLOOK_MAIL_SUMMARY_SELECT,
  })
  const data = await mailGet<GraphCollection<GraphMailMessage>>(
    `/me/messages?${params.toString()}`,
    `/me/messages?${outlookParams.toString()}`,
    { headers: { ConsistencyLevel: 'eventual' } },
  )
  const messages = (data.value ?? []).flatMap(message => mailMessageId(message) ? [mailSummary(message)] : [])
  return { query: options.query, count: messages.length, messages }
}

export async function getMailMessage(messageId: string): Promise<GraphMailMessageDetail> {
  const id = messageId.trim()
  if (!id) throw new Error('messageId is required for get_mail_message')
  const params = new URLSearchParams({ '$select': `${MAIL_SUMMARY_SELECT},body` })
  const outlookParams = new URLSearchParams({ '$select': `${OUTLOOK_MAIL_SUMMARY_SELECT},Body` })
  const message = await mailGet<GraphMailMessage>(
    `/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
    `/me/messages/${encodeURIComponent(id)}?${outlookParams.toString()}`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } },
  )
  const body = message.body ?? (message.Body ? {
    content: message.Body.Content,
    contentType: message.Body.ContentType,
  } : undefined)
  return {
    ...mailSummary(message),
    body: body?.content?.trim() || '',
    bodyContentType: body?.contentType || '',
  }
}

export async function graphGet<T = unknown>(pathOrUrl: string, options: GraphGetOptions = {}): Promise<T> {
  const url = normalizeGraphUrl(pathOrUrl)
  return await authenticatedGet<T>({
    url,
    options,
    serviceName: 'Microsoft Graph',
    getToken: forceRefresh => extractMicrosoftTokenFromChrome('graph', forceRefresh),
    clearCachedToken: () => { delete microsoftTokenCache.graph },
    hasStaticToken: () => Boolean(process.env.MICROSOFT_GRAPH_TOKEN?.trim()),
  })
}

async function outlookGet<T = unknown>(pathOrUrl: string, options: GraphGetOptions = {}): Promise<T> {
  const url = normalizeOutlookUrl(pathOrUrl)
  return await authenticatedGet<T>({
    url,
    options,
    serviceName: 'Outlook mail API',
    getToken: forceRefresh => extractMicrosoftTokenFromChrome('outlook', forceRefresh),
    clearCachedToken: () => { delete microsoftTokenCache.outlook },
    hasStaticToken: () => Boolean(process.env.MICROSOFT_OUTLOOK_TOKEN?.trim()),
  })
}

async function mailGet<T>(
  graphPath: string,
  outlookPath: string,
  options: GraphGetOptions = {},
): Promise<T> {
  let graphError: unknown
  let graphMailSupport: boolean | null = null

  try {
    graphMailSupport = tokenSupportsMailRead(await extractMicrosoftTokenFromChrome('graph'))
  } catch (error) {
    graphError = error
    graphMailSupport = false
  }

  if (graphMailSupport !== false) {
    try {
      return await graphGet<T>(graphPath, options)
    } catch (error) {
      graphError = error
    }
  }

  try {
    return await outlookGet<T>(outlookPath, options)
  } catch (outlookError) {
    if (graphError) {
      throw new Error(
        `Mail read failed through Graph (${describeError(graphError)}) and Outlook fallback (${describeError(outlookError)})`,
      )
    }
    throw outlookError
  }
}

async function authenticatedGet<T>(config: {
  url: string
  options: GraphGetOptions
  serviceName: string
  getToken: (forceRefresh: boolean) => Promise<string>
  clearCachedToken: () => void
  hasStaticToken: () => boolean
}): Promise<T> {
  const { url, options, serviceName, getToken, clearCachedToken, hasStaticToken } = config
  const maxAttempts = clampInteger(options.maxAttempts ?? GRAPH_MAX_ATTEMPTS, 1, 5)
  let forceTokenRefresh = false
  let lastTransportError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const token = await getToken(forceTokenRefresh)
    forceTokenRefresh = false
    let response: GraphHttpResponse
    try {
      response = await requestJson(url, token, options.headers)
    } catch (error) {
      lastTransportError = error
      if (attempt >= maxAttempts) break
      await delay(retryDelayMs(attempt))
      continue
    }

    if (response.statusCode === 401 && !hasStaticToken() && attempt < maxAttempts) {
      clearCachedToken()
      forceTokenRefresh = true
      continue
    }

    if (isRetryableStatus(response.statusCode) && attempt < maxAttempts) {
      await delay(retryDelayMs(attempt, response.retryAfter))
      continue
    }

    if (response.statusCode < 200 || response.statusCode >= 300 || isGraphError(response.data)) {
      const error = isGraphError(response.data) ? response.data.error : undefined
      throw new Error(`${error?.code || response.statusCode}: ${error?.message || response.statusMessage || 'Microsoft Graph request failed'}`)
    }
    return response.data as T
  }

  throw new Error(
    `${serviceName} connection failed after ${maxAttempts} attempts: ${describeError(lastTransportError)}`,
  )
}

async function requestJson(
  url: string,
  token: string,
  extraHeaders: Record<string, string> = {},
): Promise<GraphHttpResponse> {
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  })
  const responseText = await response.text()
  if (Buffer.byteLength(responseText, 'utf8') > GRAPH_MAX_RESPONSE_BYTES) {
    throw new Error(`Microsoft API response exceeded ${GRAPH_MAX_RESPONSE_BYTES} bytes`)
  }
  let data: unknown = null
  if (responseText) {
    try {
      data = JSON.parse(responseText) as unknown
    } catch (error) {
      throw new Error(`Microsoft API returned invalid JSON (HTTP ${response.status}): ${describeError(error)}`)
    }
  }
  return {
    statusCode: response.status,
    statusMessage: response.statusText,
    retryAfter: response.headers.get('retry-after') ?? undefined,
    data,
  }
}

function mailSummary(message: GraphMailMessage): GraphMailMessageSummary {
  const sender = message.from ?? message.From ?? message.sender ?? message.Sender
  const senderAddress = readEmailAddress(sender)
  const toRecipients = message.toRecipients ?? message.ToRecipients ?? []
  const ccRecipients = message.ccRecipients ?? message.CcRecipients ?? []
  return {
    id: mailMessageId(message),
    subject: message.subject || message.Subject || '(no subject)',
    receivedDateTime: message.receivedDateTime || message.ReceivedDateTime || '',
    sentDateTime: message.sentDateTime || message.SentDateTime || '',
    sender: senderAddress.name || senderAddress.address || 'Unknown',
    senderAddress: senderAddress.address,
    toRecipients: toRecipients.map(formatEmailAddress).filter(Boolean),
    ccRecipients: ccRecipients.map(formatEmailAddress).filter(Boolean),
    preview: stripHtml(message.bodyPreview || message.BodyPreview || '').slice(0, 1_000),
    isRead: (message.isRead ?? message.IsRead) === true,
    hasAttachments: (message.hasAttachments ?? message.HasAttachments) === true,
    webLink: message.webLink || message.WebLink || '',
  }
}

function mailMessageId(message: GraphMailMessage): string {
  return message.id || message.Id || ''
}

function formatEmailAddress(recipient: GraphEmailAddress): string {
  const { name, address } = readEmailAddress(recipient)
  if (name && address && name.toLowerCase() !== address.toLowerCase()) return `${name} <${address}>`
  return name || address
}

function readEmailAddress(recipient: GraphEmailAddress | undefined): { name: string; address: string } {
  return {
    name: recipient?.emailAddress?.name?.trim() || recipient?.EmailAddress?.Name?.trim() || '',
    address: recipient?.emailAddress?.address?.trim() || recipient?.EmailAddress?.Address?.trim() || '',
  }
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500
}

function retryDelayMs(attempt: number, retryAfter?: string | string[]): number {
  const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter
  if (value) {
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000)
    const retryAt = Date.parse(value)
    if (Number.isFinite(retryAt)) return Math.min(Math.max(retryAt - Date.now(), 0), 30_000)
  }
  return Math.min(500 * (2 ** Math.max(attempt - 1, 0)), 5_000)
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error ?? 'unknown error')
  const code = 'code' in error && typeof error.code === 'string' ? ` (${error.code})` : ''
  const cause = error.cause && error.cause !== error ? `; caused by ${describeError(error.cause)}` : ''
  return `${error.name}: ${error.message}${code}${cause}`
}

function tokenSupportsMailRead(token: string): boolean | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      scp?: unknown
      roles?: unknown
    }
    const scopes = [
      ...(typeof claims.scp === 'string' ? claims.scp.split(/\s+/) : []),
      ...(Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === 'string') : []),
    ]
    if (scopes.length === 0) return null
    return scopes.some(scope => /^mail\.(read|readbasic|readwrite)(\.|$)/i.test(scope))
  } catch {
    return null
  }
}

async function resolveChat(chatId?: string, chatName?: string): Promise<{ id: string; topic: string; chatType: string }> {
  if (chatId?.trim()) {
    const id = chatId.trim()
    const chat = await graphGet<GraphChat>(`/me/chats/${encodeURIComponent(id)}`)
    return { id, topic: chat.topic || '1:1 Chat', chatType: chat.chatType || '' }
  }

  const name = chatName?.trim()
  if (!name) throw new Error('chatId or chatName is required')
  const normalized = name.toLowerCase()
  const chats = await listTeamsChats(50)
  const match = chats.find(chat => chat.topic.toLowerCase() === normalized)
    ?? chats.find(chat => chat.topic.toLowerCase().includes(normalized))
  if (!match) throw new Error(`Teams chat not found: ${name}`)
  return { id: match.id, topic: match.topic, chatType: match.chatType }
}

async function extractMicrosoftTokenFromChrome(
  audience: MicrosoftTokenAudience,
  forceRefresh = false,
): Promise<string> {
  const envName = audience === 'graph' ? 'MICROSOFT_GRAPH_TOKEN' : 'MICROSOFT_OUTLOOK_TOKEN'
  const configuredToken = process.env[envName]?.trim()
  if (configuredToken) return configuredToken
  const cached = microsoftTokenCache[audience]
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token
  if (process.platform !== 'darwin') {
    throw new Error(`Chrome Outlook token extraction is currently supported on macOS only. Set ${envName} to use another token source.`)
  }

  if (!forceRefresh) {
    const cachedBrowserToken = await extractCachedAccessTokenFromChrome(audience)
    if (cachedBrowserToken && tokenIsUsable(cachedBrowserToken)) {
      microsoftTokenCache[audience] = {
        token: cachedBrowserToken,
        expiresAt: tokenCacheExpiry(cachedBrowserToken),
      }
      return cachedBrowserToken
    }
  }

  const existingRefresh = microsoftTokenRefreshes[audience]
  const refreshPromise = existingRefresh ?? refreshAccessTokenInChrome(audience)
  microsoftTokenRefreshes[audience] = refreshPromise
  try {
    const refreshedToken = await refreshPromise
    microsoftTokenCache[audience] = {
      token: refreshedToken,
      expiresAt: tokenCacheExpiry(refreshedToken),
    }
    return refreshedToken
  } catch (error) {
    throw new Error(microsoftTokenHelp(envName, error))
  } finally {
    if (microsoftTokenRefreshes[audience] === refreshPromise) delete microsoftTokenRefreshes[audience]
  }
}

async function extractCachedAccessTokenFromChrome(audience: MicrosoftTokenAudience): Promise<string> {
  const targetMarker = audience === 'graph' ? 'graph.microsoft.com' : 'https://outlook.office.com/mail.read'
  const jsSetup = [
    "var keys=Object.keys(localStorage).filter(function(k){return k.toLowerCase().includes('accesstoken')});",
    "var candidates=keys.map(function(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}})",
    `.filter(function(v){return v&&v.target&&v.target.toLowerCase().includes('${targetMarker}')})`,
    ".sort(function(a,b){return Number(b.expiresOn||0)-Number(a.expiresOn||0)});",
    "var tok=(candidates[0]&&candidates[0].secret)||'';",
  ].join('')
  return await extractChunkedBrowserValue(jsSetup, 'tok')
}

async function refreshAccessTokenInChrome(audience: MicrosoftTokenAudience): Promise<string> {
  const refreshState = `${BROWSER_REFRESH_STATE}_${audience}`
  const scope = audience === 'graph'
    ? 'https://graph.microsoft.com/.default openid profile offline_access'
    : 'https://outlook.office.com/.default openid profile offline_access'
  const startScript = [
    `window.${refreshState}={status:'pending'};`,
    '(function(){',
    "var keys=Object.keys(localStorage).filter(function(k){return k.toLowerCase().includes('refreshtoken')});",
    `var rk=keys.find(function(k){try{var v=JSON.parse(localStorage.getItem(k));return v.clientId==='${MICROSOFT_365_CLIENT_ID}'}catch(e){return false}});`,
    `if(!rk){window.${refreshState}={status:'error',error:'No Outlook refresh token found'};return;}`,
    'var rt=JSON.parse(localStorage.getItem(rk)).secret;',
    `var body=new URLSearchParams({client_id:'${MICROSOFT_365_CLIENT_ID}',grant_type:'refresh_token',refresh_token:rt,scope:'${scope}'});`,
    "fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()})",
    '.then(function(r){return r.json().then(function(d){return {httpStatus:r.status,data:d}})})',
    `.then(function(x){window.${refreshState}={status:x.data.access_token?'ready':'error',httpStatus:x.httpStatus,accessToken:x.data.access_token||'',error:x.data.error||'',errorDescription:x.data.error_description||''}})`,
    `.catch(function(e){window.${refreshState}={status:'error',error:String(e)}});`,
    '})();',
    "'started'",
  ].join('')
  await executeOutlookJavaScript(startScript)

  const deadline = Date.now() + BROWSER_TOKEN_REFRESH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(500)
    const status = await executeOutlookJavaScript(
      `var r=window.${refreshState}||{};JSON.stringify({status:r.status||'missing',error:r.error||'',errorDescription:(r.errorDescription||'').slice(0,500)})`,
    )
    let result: { status?: string; error?: string; errorDescription?: string } = {}
    try {
      result = JSON.parse(status) as typeof result
    } catch {
      // The page may be navigating; keep polling until the deadline.
    }
    if (result.status === 'ready') {
      const token = await extractChunkedBrowserValue(
        `var tok=(window.${refreshState}&&window.${refreshState}.accessToken)||'';`,
        'tok',
      )
      await executeOutlookJavaScript(`delete window.${refreshState};'cleared'`)
      if (token) return token
      throw new Error('Browser token refresh completed without an access token')
    }
    if (result.status === 'error') {
      await executeOutlookJavaScript(`delete window.${refreshState};'cleared'`)
      throw new Error([result.error, result.errorDescription].filter(Boolean).join(': ') || 'Browser token refresh failed')
    }
  }
  await executeOutlookJavaScript(`delete window.${refreshState};'cleared'`)
  throw new Error('Timed out refreshing the Microsoft 365 token in Chrome Outlook')
}

async function extractChunkedBrowserValue(jsSetup: string, variableName: string): Promise<string> {
  let token = ''
  for (let index = 0; index < TOKEN_CHUNKS; index += 1) {
    const start = index * TOKEN_CHUNK_SIZE
    const chunk = await executeOutlookJavaScript(
      `${jsSetup}${variableName}.substring(${start},${start}+${TOKEN_CHUNK_SIZE})`,
    )
    if (!chunk || chunk === 'missing value') break
    token += chunk
  }
  return token
}

async function executeOutlookJavaScript(browserJavaScript: string): Promise<string> {
  const script = [
    'tell application "Google Chrome"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if URL of t starts with "https://${OUTLOOK_URL_MARKERS[0]}/" or URL of t starts with "https://${OUTLOOK_URL_MARKERS[1]}/" then`,
    `        return execute t javascript ${JSON.stringify(browserJavaScript)}`,
    '      end if',
    '    end repeat',
    '  end repeat',
    'end tell',
  ].join('\n')
  const result = await execFileAsync('/usr/bin/osascript', ['-e', script], {
    timeout: APPLESCRIPT_TIMEOUT_MS,
    maxBuffer: 32 * 1024,
  })
  return result.stdout.trim()
}

function tokenIsUsable(token: string): boolean {
  const expiresAt = tokenExpiration(token)
  return expiresAt === null || expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS
}

function tokenExpiration(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof decoded.exp === 'number' && Number.isFinite(decoded.exp) ? decoded.exp * 1_000 : null
  } catch {
    return null
  }
}

function tokenCacheExpiry(token: string): number {
  const fallback = Date.now() + TOKEN_FALLBACK_CACHE_MS
  const expiresAt = tokenExpiration(token)
  return expiresAt === null ? fallback : Math.min(fallback, Math.max(Date.now(), expiresAt - TOKEN_REFRESH_SKEW_MS))
}

function normalizeGraphUrl(pathOrUrl: string): string {
  const value = pathOrUrl.trim()
  if (!value) throw new Error('Graph path is required')
  const url = value.startsWith('http') ? new URL(value) : new URL(`${GRAPH_BASE_URL}${value.startsWith('/') ? value : `/${value}`}`)
  if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com') {
    throw new Error('Only https://graph.microsoft.com read requests are supported')
  }
  return url.toString()
}

function normalizeOutlookUrl(pathOrUrl: string): string {
  const value = pathOrUrl.trim()
  if (!value) throw new Error('Outlook mail path is required')
  const url = value.startsWith('http') ? new URL(value) : new URL(`${OUTLOOK_BASE_URL}${value.startsWith('/') ? value : `/${value}`}`)
  if (url.protocol !== 'https:' || url.hostname !== 'outlook.office.com' || !url.pathname.startsWith('/api/v2.0/')) {
    throw new Error('Only https://outlook.office.com/api/v2.0 read requests are supported')
  }
  return url.toString()
}

function resolveDateRange(date?: string, startDateTime?: string, endDateTime?: string): { startDateTime: string; endDateTime: string } | null {
  if (startDateTime || endDateTime) {
    if (!startDateTime || !endDateTime) throw new Error('startDateTime and endDateTime must be provided together')
    const start = new Date(startDateTime)
    const end = new Date(endDateTime)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error('Invalid date range')
    return { startDateTime: start.toISOString(), endDateTime: end.toISOString() }
  }

  if (!date) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must use YYYY-MM-DD')
  const start = new Date(`${date}T00:00:00`)
  const end = new Date(start)
  end.setDate(start.getDate() + 1)
  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() }
}

function oldestMessageTime(messages: GraphChatMessage[]): number | null {
  const times = messages
    .map(message => message.createdDateTime ? Date.parse(message.createdDateTime) : Number.NaN)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  return times[0] ?? null
}

function displaySender(from: GraphMessageFrom | undefined): string {
  return from?.user?.displayName || from?.application?.displayName || 'Unknown'
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim()
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function isGraphError(value: unknown): value is { error: { code?: string; message?: string } } {
  return Boolean(value && typeof value === 'object' && 'error' in value)
}

function microsoftTokenHelp(envName: string, error?: unknown): string {
  const detail = error instanceof Error ? ` ${error.message}` : ''
  return [
    `Unable to read a Microsoft 365 token from Chrome Outlook.${detail}`,
    'Open https://outlook.office.com/mail/ in Google Chrome, sign in, then enable View > Developer > Allow JavaScript from Apple Events.',
    `Alternatively set ${envName} for this process.`,
  ].join(' ')
}
