/* House of Mercy access rules: invitations, membership, roles.
 * Pure functions over a plain `state` object so the same rules can move to a
 * server. In this browser prototype they are NOT a security boundary. */
(function (root) {
  'use strict';
  const INVITE_DAYS = 7;
  const ROLES = ['Admin', 'Editor', 'Contributor'];
  const MSG = {
    already_member: 'This person is already a member of House of Mercy.',
    pending: 'An invitation is already pending for this email.',
    invalid_email: 'Please enter a valid email address.',
    expired: 'This invitation has expired.',
    accepted: 'This invitation has already been accepted.',
    inactive: 'This invitation is no longer active.',
    not_found: 'We couldn’t find this invitation. Ask an Admin to send you a new one.',
    wrong_account: 'This invitation was sent to a different email address.',
    no_access: 'You no longer have access to this workspace.',
    forbidden: 'Only an Admin can do that.',
    last_admin: 'There must always be at least one Admin. Promote another member to Admin first.'
  };
  const norm = e => String(e || '').trim().toLowerCase();
  const isValidEmail = e => { const v = norm(e); return v.length <= 254 && /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/.test(v); };
  const newToken = () => {
    const b = new Uint8Array(32); (root.crypto || require('crypto').webcrypto).getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  };
  const fail = (code, extra) => ({ ok: false, code, message: MSG[code], ...extra });
  const ensure = s => { s.invitations ||= []; s.inviteRequests ||= []; s.accounts ||= []; s.members ||= []; return s; };
  const members = (s, ws) => s.members.filter(m => m.workspaceId === ws);
  const memberOf = (s, ws, email) => s.members.find(m => m.workspaceId === ws && norm(m.email) === norm(email));
  const admins = (s, ws) => members(s, ws).filter(m => m.role === 'Admin');
  const isActive = (i, now) => i.status === 'pending' && new Date(i.expiresAt) > now;
  const isAdmin = (s, ws, email) => memberOf(s, ws, email)?.role === 'Admin';
  const requireAdmin = (s, ws, actor) => (isAdmin(s, ws, actor) ? null : fail('forbidden'));

  function invite(s, ws, actor, email, role, now = new Date()) {
    ensure(s); const denied = requireAdmin(s, ws, actor); if (denied) return denied;
    if (!isValidEmail(email)) return fail('invalid_email');
    if (!ROLES.includes(role)) return { ok: false, code: 'invalid_role', message: 'Please choose a valid role.' };
    const e = norm(email);
    if (memberOf(s, ws, e)) return fail('already_member');
    const pending = s.invitations.find(i => i.workspaceId === ws && i.email === e && isActive(i, now));
    if (pending) return fail('pending', { invitation: pending });
    s.invitations.forEach(i => { if (i.workspaceId === ws && i.email === e && i.status === 'pending') i.status = 'expired'; });
    const inv = { id: newToken().slice(0, 12), token: newToken(), workspaceId: ws, email: e, role, status: 'pending',
      invitedBy: norm(actor), createdAt: now.toISOString(), expiresAt: new Date(+now + INVITE_DAYS * 864e5).toISOString() };
    s.invitations.push(inv); return { ok: true, invitation: inv };
  }
  // Resend issues a fresh token and expiry; the old link stops working.
  function resend(s, ws, actor, id, now = new Date()) {
    ensure(s); const denied = requireAdmin(s, ws, actor); if (denied) return denied;
    const inv = s.invitations.find(i => i.id === id && i.workspaceId === ws && i.status === 'pending');
    if (!inv) return fail('inactive');
    inv.token = newToken(); inv.expiresAt = new Date(+now + INVITE_DAYS * 864e5).toISOString(); return { ok: true, invitation: inv };
  }
  function cancel(s, ws, actor, id) {
    ensure(s); const denied = requireAdmin(s, ws, actor); if (denied) return denied;
    const inv = s.invitations.find(i => i.id === id && i.workspaceId === ws && i.status === 'pending');
    if (!inv) return fail('inactive');
    inv.status = 'cancelled'; return { ok: true, invitation: inv };
  }
  /* Classify an invitation link for the current session (email or null). */
  function inspect(s, token, sessionEmail, now = new Date()) {
    ensure(s); const inv = s.invitations.find(i => i.token === token && token);
    if (!inv) return fail('not_found', { state: 'not_found' });
    const me = sessionEmail ? norm(sessionEmail) : null;
    const base = { invitation: inv, hasAccount: s.accounts.some(a => norm(a.email) === inv.email) };
    if (inv.status === 'accepted') return fail('accepted', { ...base, state: 'accepted', openWorkspace: !!me && !!memberOf(s, inv.workspaceId, me) });
    if (inv.status !== 'pending') return fail('inactive', { ...base, state: 'inactive' });
    if (new Date(inv.expiresAt) <= now) return fail('expired', { ...base, state: 'expired', canRequestNew: true });
    if (!me) return { ok: true, state: 'login_required', ...base };
    if (me !== inv.email) return fail('wrong_account', { ...base, state: 'wrong_account' });
    return { ok: true, state: 'ready', ...base };
  }
  /* Creates the account if needed (new user) and the membership; single-use. */
  function accept(s, token, sessionEmail, name, now = new Date()) {
    const r = inspect(s, token, sessionEmail, now); if (!r.ok || r.state !== 'ready') return r.ok ? fail('inactive') : r;
    const inv = r.invitation;
    if (!s.accounts.some(a => norm(a.email) === inv.email)) s.accounts.push({ email: inv.email, name: name || inv.email.split('@')[0] });
    const acct = s.accounts.find(a => norm(a.email) === inv.email);
    if (!memberOf(s, inv.workspaceId, inv.email)) s.members.push({ workspaceId: inv.workspaceId, name: acct.name, email: inv.email, role: inv.role });
    inv.status = 'accepted'; inv.acceptedAt = now.toISOString(); return { ok: true, invitation: inv };
  }
  /* Declining never transfers the invite; the person asks for a new one. */
  function decline(s, token, sessionEmail, now = new Date()) {
    ensure(s); const inv = s.invitations.find(i => i.token === token && i.status === 'pending');
    if (!inv) return fail('inactive');
    inv.status = 'declined'; inv.declinedAt = now.toISOString(); return { ok: true, invitation: inv };
  }
  function requestNew(s, ws, email, now = new Date()) {
    ensure(s); if (!isValidEmail(email)) return fail('invalid_email');
    const e = norm(email);
    if (!s.inviteRequests.some(r => r.workspaceId === ws && r.email === e)) s.inviteRequests.push({ workspaceId: ws, email: e, at: now.toISOString() });
    return { ok: true, message: 'Request sent. An Admin can send a new invitation to this email.' };
  }
  function changeRole(s, ws, actor, email, role) {
    ensure(s); const denied = requireAdmin(s, ws, actor); if (denied) return denied;
    const m = memberOf(s, ws, email); if (!m) return fail('no_access');
    if (!ROLES.includes(role)) return { ok: false, code: 'invalid_role', message: 'Please choose a valid role.' };
    if (m.role === 'Admin' && role !== 'Admin' && admins(s, ws).length < 2) return fail('last_admin');
    m.role = role; return { ok: true, member: m };
  }
  /* Revokes workspace access only; the account and past activity remain. */
  function removeMember(s, ws, actor, email) {
    ensure(s); const self = norm(actor) === norm(email);
    if (!self) { const denied = requireAdmin(s, ws, actor); if (denied) return denied; }
    const m = memberOf(s, ws, email); if (!m) return fail('no_access');
    if (m.role === 'Admin' && admins(s, ws).length < 2) return fail('last_admin');
    s.members = s.members.filter(x => x !== m); return { ok: true, member: m };
  }
  /* Server-side style gate: authenticated + member + role. */
  function authorize(s, ws, email, roles) {
    ensure(s); if (!email) return { ok: false, code: 'unauthenticated', message: 'Please sign in to continue.' };
    const m = memberOf(s, ws, email); if (!m) return fail('no_access');
    if (roles && !roles.includes(m.role)) return fail('forbidden');
    return { ok: true, member: m };
  }
  const api = { INVITE_DAYS, ROLES, MSG, isValidEmail, newToken, invite, resend, cancel, inspect, accept, decline, requestNew,
    changeRole, removeMember, authorize, memberOf, members, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HomAccess = api;
})(typeof window !== 'undefined' ? window : globalThis);
