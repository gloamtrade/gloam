/**
 * The few Telegram Bot API shapes and calls the community helper uses.
 * Server only. Plain fetch, no SDK. Every call is best effort: a failure is
 * returned, never thrown, so one bad call cannot break the webhook.
 */

export type TgUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
};

export type TgChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  title?: string;
  is_forum?: boolean;
};

export type TgEntity = {
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
  /** Where a text_link points: a link hidden behind other words. */
  url?: string;
};

/** One size of a photo. Telegram sends several, smallest first. */
export type TgPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

/** A file sent as a document, which is how uncompressed screenshots arrive. */
export type TgDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TgMessage = {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  sender_chat?: TgChat;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  photo?: TgPhotoSize[];
  document?: TgDocument;
  /** Shared by the messages of one album. */
  media_group_id?: string;
  reply_to_message?: TgMessage;
  forum_topic_created?: unknown;
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
  via_bot?: TgUser;
  /** Set by Telegram on a post its linked channel forwarded into the group by itself. */
  is_automatic_forward?: boolean;
  /** Set on a forwarded message: who it first came from (a user, a group or a channel). */
  forward_origin?: { type: "user" | "hidden_user" | "chat" | "channel"; chat?: TgChat; sender_chat?: TgChat; sender_user?: TgUser };
  /** A reply quoting a message from another chat (a channel post, usually). */
  external_reply?: { origin?: { type: string }; chat?: TgChat; text?: string; caption?: string };
  quote?: { text?: string };
};

export type TgChatMember = {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  user: TgUser;
  is_member?: boolean;
};

export type TgChatMemberUpdated = {
  chat: TgChat;
  from: TgUser;
  date: number;
  old_chat_member: TgChatMember;
  new_chat_member: TgChatMember;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  chat_member?: TgChatMemberUpdated;
};

/** The update kinds the webhook asks Telegram for. */
export const ALLOWED_UPDATES = ["message", "edited_message", "chat_member"];

export type SendOptions = {
  /** Topic to post in. Leave out for General and private chats. */
  threadId?: number;
  /** Message to answer. Sent as a reply when it still exists. */
  replyTo?: number;
  /** "HTML" for the welcome; everything else is plain text. */
  parseMode?: "HTML";
};

const API = "https://api.telegram.org";

function token(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

/**
 * A call's outcome. `refused`: Telegram answered with an error, so nothing
 * went out; `retryAfter`: it asked to wait that many seconds (a 429). A
 * timeout or a network error is neither: the call may still have gone through.
 */
type CallResult<T> = { ok: boolean; result?: T; refused?: boolean; retryAfter?: number; description?: string };

async function call<T>(method: string, body: Record<string, unknown>): Promise<CallResult<T>> {
  const t = token();
  if (!t) return { ok: false, refused: true };
  try {
    const res = await fetch(`${API}/bot${t}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (res.ok && json?.ok) return { ok: true, result: json.result };
    const wait = Number(json?.parameters?.retry_after ?? /retry after (\d+)/i.exec(json?.description ?? "")?.[1]);
    return {
      ok: false,
      refused: true,
      ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: wait } : {}),
      ...(typeof json?.description === "string" ? { description: json.description.slice(0, 200) } : {}),
    };
  } catch {
    return { ok: false };
  }
}

/** A post that went out, or why not: refused (with Telegram's wait on a 429), or unknown after a timeout. */
export type Sent<T> = ({ ok: true } & T) | { ok: false; refused: boolean; retryAfter?: number };

function failed(r: CallResult<unknown>): Sent<never> {
  return { ok: false, refused: Boolean(r.refused), ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) };
}

/** Sends a message with link previews off, and says what became of it. */
export async function trySendMessage(chatId: number, text: string, opts: SendOptions = {}): Promise<Sent<{ messageId: number }>> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  };
  if (opts.threadId) body.message_thread_id = opts.threadId;
  if (opts.replyTo) body.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  const r = await call<{ message_id: number }>("sendMessage", body);
  return r.ok && r.result ? { ok: true, messageId: r.result.message_id } : failed(r);
}

/** Sends a message with link previews off. Returns the new message id, or null. */
export async function sendMessage(chatId: number, text: string, opts: SendOptions = {}): Promise<number | null> {
  const r = await trySendMessage(chatId, text, opts);
  return r.ok ? r.messageId : null;
}

/** Telegram's limit on a photo caption. */
export const CAPTION_MAX = 1024;

/**
 * Sends a photo (a public https URL or a file_id Telegram already holds) with
 * a plain-text caption. Returns the new message id and the photo's file_id,
 * so the next post can send the same picture without Telegram fetching it
 * again, or why it failed.
 */
export async function sendPhoto(
  chatId: number,
  photo: string,
  caption: string,
  opts: SendOptions = {},
): Promise<Sent<{ messageId: number; fileId: string | null }>> {
  if (caption.length > CAPTION_MAX) return { ok: false, refused: true };
  const body: Record<string, unknown> = { chat_id: chatId, photo, caption };
  if (opts.threadId) body.message_thread_id = opts.threadId;
  if (opts.replyTo) body.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  const r = await call<{ message_id: number; photo?: TgPhotoSize[] }>("sendPhoto", body);
  if (!r.ok || !r.result) return failed(r);
  const sizes = r.result.photo ?? [];
  return { ok: true, messageId: r.result.message_id, fileId: sizes.length ? sizes[sizes.length - 1]!.file_id : null };
}

/** The channel linked to a group (its posts come into the group): its id, null when there is none, undefined when Telegram can't say. */
export async function linkedChatId(chatId: number): Promise<number | null | undefined> {
  const r = await call<{ linked_chat_id?: number }>("getChat", { chat_id: chatId });
  if (!r.ok || !r.result) return undefined;
  const id = r.result.linked_chat_id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

/** The group's admins' ids (bots included), or null when Telegram can't say. */
export async function getChatAdministrators(chatId: number): Promise<number[] | null> {
  const r = await call<TgChatMember[]>("getChatAdministrators", { chat_id: chatId });
  return r.ok && Array.isArray(r.result) ? r.result.map((m) => m.user.id) : null;
}

/**
 * What a moderation call came to. `noRights`: Telegram refused it because the
 * bot lacks the admin right (Delete messages, or Ban users, which also covers
 * mutes), so the owner has to grant it. Any other failure is not that.
 */
export type ModResult = { ok: boolean; noRights: boolean };

const NO_RIGHTS = /not enough rights|chat_admin_required|have no rights|need administrator rights|bot is not an administrator/i;
/** A message that is already gone (Rose or its author took it down first) counts as deleted. */
const ALREADY_GONE = /message to delete not found|message_id_invalid/i;
/** Telegram says this for a message over 48 hours old and for a bot without Delete messages alike. */
const CANT_DELETE = /message can't be deleted/i;

/** The bot's own Delete messages right in a chat, read only when a delete was refused. Null when Telegram won't say. */
async function canDelete(chatId: number): Promise<boolean | null> {
  const me = await getMe();
  const r = me ? await call<{ status: string; can_delete_messages?: boolean }>("getChatMember", { chat_id: chatId, user_id: me.id }) : null;
  const m = r?.ok ? r.result : undefined;
  if (!m) return null;
  return m.status === "creator" ? true : m.status === "administrator" ? m.can_delete_messages === true : false;
}

async function modCall(method: string, body: Record<string, unknown>): Promise<ModResult> {
  const r = await call(method, body);
  if (r.ok) return { ok: true, noRights: false };
  const why = r.description ?? "";
  if (method === "deleteMessage" && ALREADY_GONE.test(why)) return { ok: true, noRights: false };
  // an old message, or no right to delete: the bot's own rights say which
  if (method === "deleteMessage" && CANT_DELETE.test(why)) return { ok: false, noRights: (await canDelete(Number(body.chat_id))) === false };
  return { ok: false, noRights: NO_RIGHTS.test(why) };
}

/** Deletes a message, and says whether Telegram refused for lack of the Delete messages right. */
export function removeMessage(chatId: number, messageId: number): Promise<ModResult> {
  return modCall("deleteMessage", { chat_id: chatId, message_id: messageId });
}

/** Deletes a message. Works only while the bot is an admin with Delete messages. */
export async function deleteMessage(chatId: number, messageId: number): Promise<boolean> {
  return (await removeMessage(chatId, messageId)).ok;
}

/**
 * Removes someone from the group and keeps them out, deleting what they posted
 * there (revoke_messages). Works only while the bot is an admin with Ban users.
 * A negative id is a chat someone posted as (a channel): that chat may no
 * longer post in the group, and the person behind it still can as themselves.
 */
export function banUser(chatId: number, userId: number): Promise<ModResult> {
  if (userId < 0) return modCall("banChatSenderChat", { chat_id: chatId, sender_chat_id: userId });
  return modCall("banChatMember", { chat_id: chatId, user_id: userId, revoke_messages: true });
}

/**
 * Removes someone from the group and keeps them out, deleting what they posted
 * there. Works only while the bot is an admin with Ban users. An admin can
 * lift it in the group's settings.
 */
export async function banMember(chatId: number, userId: number): Promise<boolean> {
  return (await banUser(chatId, userId)).ok;
}

/** Every permission a member can have, all off (a mute) or all on (the mute lifted). */
function permissions(on: boolean): Record<string, boolean> {
  return Object.fromEntries(
    [
      "can_send_messages",
      "can_send_audios",
      "can_send_documents",
      "can_send_photos",
      "can_send_videos",
      "can_send_video_notes",
      "can_send_voice_notes",
      "can_send_polls",
      "can_send_other_messages",
      "can_add_web_page_previews",
      "can_change_info",
      "can_invite_users",
      "can_pin_messages",
      "can_manage_topics",
    ].map((k) => [k, on]),
  );
}

/**
 * Mutes someone until `untilSec` (unix seconds). Needs the Ban users right, which covers restricting.
 * A chat someone posted as (a negative id) can't be muted: nothing is done, and the caller's delete stands.
 */
export async function muteUser(chatId: number, userId: number, untilSec: number): Promise<ModResult> {
  if (userId < 0) return { ok: false, noRights: false };
  return modCall("restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: permissions(false),
    use_independent_chat_permissions: true,
    until_date: Math.floor(untilSec),
  });
}

/** Lets someone the bot banned join the group again (a chat posted as, by its negative id: post again). Only lifts a ban; never removes a member. */
export async function unbanMember(chatId: number, userId: number): Promise<boolean> {
  if (userId < 0) return (await call("unbanChatSenderChat", { chat_id: chatId, sender_chat_id: userId })).ok;
  return (await call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true })).ok;
}

/** Lifts a mute: Telegram's way is every permission on, which leaves the member with the group's defaults. */
export async function unmuteUser(chatId: number, userId: number): Promise<boolean> {
  if (userId < 0) return false;
  return (await modCall("restrictChatMember", { chat_id: chatId, user_id: userId, permissions: permissions(true), use_independent_chat_permissions: true })).ok;
}

/** The bot's own account, read once per server instance. */
export async function getMe(): Promise<TgUser | null> {
  const g = globalThis as { __gloamTgMe?: TgUser };
  if (g.__gloamTgMe) return g.__gloamTgMe;
  const r = await call<TgUser>("getMe", {});
  if (r.ok && r.result?.id) g.__gloamTgMe = r.result;
  return g.__gloamTgMe ?? null;
}

type TgFile = { file_id: string; file_size?: number; file_path?: string };

/** Where Telegram keeps a file, and its size when known. Null when it will not say. */
export async function getFile(fileId: string): Promise<{ path: string; size: number | null } | null> {
  const r = await call<TgFile>("getFile", { file_id: fileId });
  const path = r.ok ? r.result?.file_path : undefined;
  if (!path || !/^[\w./-]{1,200}$/.test(path) || path.includes("..")) return null;
  return { path, size: typeof r.result?.file_size === "number" ? r.result.file_size : null };
}

/**
 * Downloads a file from Telegram's file server, at most `maxBytes`. Null when
 * it is bigger, the download fails or there is no token. The URL carries the
 * token, so it is never logged.
 */
export async function downloadFile(path: string, maxBytes: number): Promise<Uint8Array | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await fetch(`${API}/file/bot${t}/${path}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => {});
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Re-registers the webhook at the URL Telegram already has, with the same
 * secret, asking for ALLOWED_UPDATES. Nothing pending is dropped.
 */
export async function refreshWebhook(secret: string): Promise<{ ok: boolean; url: string | null }> {
  const info = await call<{ url?: string }>("getWebhookInfo", {});
  const url = info.ok ? info.result?.url ?? null : null;
  if (!url) return { ok: false, url: null };
  const r = await call<boolean>("setWebhook", { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES });
  return { ok: r.ok, url };
}

/** How many people are in a chat right now, or null. */
export async function getChatMemberCount(chatId: number): Promise<number | null> {
  const r = await call<number>("getChatMemberCount", { chat_id: chatId });
  return r.ok && typeof r.result === "number" ? r.result : null;
}
