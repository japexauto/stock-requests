// Sends the parts manager an email and a phone notification when a stock request comes in,
// or when an open request is bumped to urgent.
//
// Called two ways:
//  1. By a Supabase Database Webhook on stock_requests (insert and update). It must send the
//     header  x-webhook-secret: <WEBHOOK_SECRET>
//  2. By the app's "Send a test" button, with the signed-in manager's login. Sends a test alert to them only.
//
// Secrets (Edge Functions > Secrets). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//   WEBHOOK_SECRET      any long random string, also typed into the webhook header
//   APP_URL             web address of the app, e.g. https://stock.japex.co.uk/
//   VAPID_PUBLIC_KEY    from tools/make-keys.html (the public one also goes in config.js)
//   VAPID_PRIVATE_KEY   from tools/make-keys.html
//   MAIL_FROM           accounts@japex.co.uk
//   MAIL_FROM_NAME      optional, defaults to "Japex Stock Requests"
// Then ONE of these sets, depending on how accounts@japex.co.uk is hosted:
//   Microsoft 365:  MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
//   Google / other: SMTP_HOST, SMTP_USER, SMTP_PASS (port 465 only; Supabase blocks 25 and 587)
//   Resend:         RESEND_API_KEY

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import webpush from 'npm:web-push@3.6.7';
import nodemailer from 'npm:nodemailer@6.10.1';

const env = (k: string) => Deno.env.get(k) ?? '';
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const APP_URL = (env('APP_URL') || '/').replace(/#.*$/, '');
const MAIL_FROM = env('MAIL_FROM');
const MAIL_FROM_NAME = env('MAIL_FROM_NAME') || 'Japex Stock Requests';

type Req = {
  id: string; item_id: string | null; photo_path: string | null; note: string; qty_left: string;
  urgency: 'normal' | 'urgent'; status: string; requested_by: string | null; requested_at: string;
};
type Item = { name: string; size_grade: string; supplier: string; order_qty: string };
type Msg = { subject: string; title: string; body: string; html: string; url: string; urgent: boolean };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

// Constant-time compare so the secret can't be guessed a character at a time.
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function shortName(email: string | null) {
  if (!email) return 'Someone';
  const n = email.split('@')[0].split(/[._-]/)[0];
  return n.charAt(0).toUpperCase() + n.slice(1);
}

async function buildMessage(r: Req, bumped: boolean): Promise<Msg> {
  let item: Item | null = null;
  if (r.item_id) {
    const { data } = await sb.from('stock_items').select('name, size_grade, supplier, order_qty').eq('id', r.item_id).single();
    item = data;
  }
  let photoUrl = '';
  if (r.photo_path) {
    const { data } = await sb.storage.from('stock-photos').createSignedUrl(r.photo_path, 60 * 60 * 24 * 7);
    photoUrl = data?.signedUrl ?? '';
  }
  const urgent = r.urgency === 'urgent';
  const what = item ? [item.name, item.size_grade].filter(Boolean).join(' ') : (r.note || 'Photo request');
  const who = shortName(r.requested_by);
  const prefix = bumped ? 'NOW URGENT: ' : urgent ? 'URGENT: ' : '';
  const title = prefix + what;
  const bodyParts = [
    r.qty_left ? 'Left: ' + r.qty_left : '',
    item?.supplier ? 'From ' + item.supplier : '',
    item?.order_qty ? 'Usual order ' + item.order_qty : '',
    'Asked by ' + who,
  ].filter(Boolean);
  const url = APP_URL + '#open';
  const rows: [string, string][] = [
    ['Item', item ? item.name : '(no label, see photo/note)'],
    ['Size / grade', item?.size_grade ?? ''],
    ['Supplier', item?.supplier ?? ''],
    ['Usual order', item?.order_qty ?? ''],
    ['Quantity left', r.qty_left],
    ['Note', r.note],
    ['Urgency', urgent ? 'URGENT' : 'Normal'],
    ['Asked by', r.requested_by ?? ''],
    ['When', new Date(r.requested_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })],
  ];
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;color:#232721">` +
    (urgent ? `<p style="background:#c4221f;color:#fff;padding:8px 12px;font-weight:bold;margin:0 0 12px">${bumped ? 'This request has been marked URGENT' : 'URGENT request'}</p>` : '') +
    `<table cellpadding="6" style="border-collapse:collapse">` +
    rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="color:#62646a">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('') +
    `</table>` +
    (photoUrl ? `<p><a href="${esc(photoUrl)}">View the photo</a> (link works for 7 days)</p>` : '') +
    `<p><a href="${esc(url)}" style="display:inline-block;background:#232721;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open stock requests</a></p>` +
    `</div>`;
  return { subject: 'Stock request: ' + title, title, body: bodyParts.join(' · '), html, url, urgent };
}

// ---------- Email ----------
async function sendEmail(to: string[], m: Msg) {
  if (!to.length || !MAIL_FROM) return 'skipped (no recipients or MAIL_FROM)';
  const text = `${m.title}\n${m.body}\n\nOpen: ${m.url}`;

  if (env('MS_TENANT_ID')) {
    // Microsoft 365 via Graph (SMTP on 587 is blocked from Supabase).
    const tok = await fetch(`https://login.microsoftonline.com/${env('MS_TENANT_ID')}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: env('MS_CLIENT_ID'), client_secret: env('MS_CLIENT_SECRET'),
        scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
      }),
    }).then((r) => r.json());
    if (!tok.access_token) throw new Error('Microsoft login failed: ' + (tok.error_description || tok.error));
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_FROM)}/sendMail`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tok.access_token, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: m.subject, importance: m.urgent ? 'high' : 'normal',
          body: { contentType: 'HTML', content: m.html },
          toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
        },
        saveToSentItems: true,
      }),
    });
    if (!res.ok) throw new Error('Microsoft send failed: ' + res.status + ' ' + (await res.text()));
    return 'sent via Microsoft 365';
  }

  if (env('SMTP_HOST')) {
    const t = nodemailer.createTransport({
      host: env('SMTP_HOST'), port: 465, secure: true,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    });
    await t.sendMail({ from: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`, to, subject: m.subject, text, html: m.html, priority: m.urgent ? 'high' : 'normal' });
    return 'sent via SMTP';
  }

  if (env('RESEND_API_KEY')) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env('RESEND_API_KEY'), 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${MAIL_FROM_NAME} <${MAIL_FROM}>`, to, subject: m.subject, html: m.html, text }),
    });
    if (!res.ok) throw new Error('Resend failed: ' + res.status + ' ' + (await res.text()));
    return 'sent via Resend';
  }
  return 'skipped (no email service set up)';
}

// ---------- Phone notifications ----------
async function sendPush(emails: string[], m: Msg) {
  if (!emails.length || !env('VAPID_PRIVATE_KEY')) return 'skipped';
  webpush.setVapidDetails('mailto:' + (MAIL_FROM || 'accounts@japex.co.uk'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  const { data: subs } = await sb.from('stock_push_subs').select('endpoint, p256dh, auth').in('email', emails);
  const payload = JSON.stringify({ title: m.title, body: m.body, url: m.url, urgent: m.urgent });
  let ok = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
        { TTL: 60 * 60 * 12, urgency: m.urgent ? 'high' : 'normal' });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // Phone has turned alerts off or the app was removed: forget it.
      if (code === 404 || code === 410) await sb.from('stock_push_subs').delete().eq('endpoint', s.endpoint);
      else console.error('push failed', code, (e as Error).message);
    }
  }));
  return `${ok} of ${(subs ?? []).length} phones`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  // ---- Test button in the app: signed-in manager, sends to themselves only ----
  if (!req.headers.get('x-webhook-secret')) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await sb.auth.getUser(token);
    const email = user?.email?.toLowerCase();
    if (!email) return json(401, { error: 'Not signed in' });
    const { data: mgr } = await sb.from('stock_managers').select('email').eq('email', email).maybeSingle();
    if (!mgr) return json(403, { error: 'Only stock managers can send a test' });
    const m: Msg = {
      subject: 'Stock request: test', title: 'Test alert', body: 'If you can read this, alerts are working.',
      html: '<p style="font-family:Arial,sans-serif">Test from Japex stock requests. Email alerts are working.</p>',
      url: APP_URL + '#open', urgent: false,
    };
    const result: Record<string, string> = {};
    try { result.push = await sendPush([email], m); } catch (e) { result.push = 'error: ' + (e as Error).message; }
    try { result.email = await sendEmail([email], m); } catch (e) { result.email = 'error: ' + (e as Error).message; }
    return json(200, result);
  }

  // ---- Database webhook ----
  if (!sameSecret(req.headers.get('x-webhook-secret') || '', env('WEBHOOK_SECRET'))) return json(401, { error: 'Bad secret' });
  const evt = await req.json();
  if (evt.table !== 'stock_requests') return json(200, { skipped: 'other table' });
  const r: Req = evt.record;
  const old: Req | null = evt.old_record;

  let bumped = false;
  if (evt.type === 'INSERT') {
    // new request: always notify
  } else if (evt.type === 'UPDATE' && old && old.urgency === 'normal' && r.urgency === 'urgent' && ['requested', 'ordered'].includes(r.status)) {
    bumped = true;
  } else {
    return json(200, { skipped: 'nothing to tell anyone' });
  }

  const { data: managers } = await sb.from('stock_managers').select('email, notify_email');
  const all = (managers ?? []).map((x) => x.email);
  const mailTo = (managers ?? []).filter((x) => x.notify_email).map((x) => x.email);
  const m = await buildMessage(r, bumped);

  const result: Record<string, string> = {};
  try { result.push = await sendPush(all, m); } catch (e) { result.push = 'error: ' + (e as Error).message; console.error(e); }
  try { result.email = await sendEmail(mailTo, m); } catch (e) { result.email = 'error: ' + (e as Error).message; console.error(e); }
  return json(200, result);
});
