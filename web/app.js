/* global document, window, fetch, URLSearchParams, history, navigator, setTimeout */
const $ = id => document.getElementById(id);
let csrf = '', current = null, chats = [], activeRun = null, sending = false, pollGeneration = 0;
const fragment = new URLSearchParams(window.location.hash.slice(1));
const setupToken = fragment.get('setup') ?? '';
history.replaceState(null, '', window.location.pathname);
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: {
    ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}),
    ...(setupToken ? { 'X-Setup-Token': setupToken } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: 'Serveur indisponible.' }));
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showLogin();
    throw new Error(data.error ?? 'La requête a échoué. Réessayez plus tard.');
  }
  return data;
}
function showLogin() { $('workspace').hidden = true; $('auth').hidden = false; $('login-form').hidden = false; pollGeneration++; }
function report(error, id = 'chat-error') { $(id).textContent = error.message; }
function bind(id, event, action) { $(id).addEventListener(event, async e => { try { await action(e); } catch (error) { report(error, $('workspace').hidden ? 'auth-error' : 'chat-error'); } }); }
const securityButton = document.createElement('button'); securityButton.className = 'text-button'; securityButton.textContent = 'Sécurité du compte';
$('logout-all').before(securityButton);
securityButton.addEventListener('click', () => $('security-dialog').showModal());
bind('close-security', 'click', () => { $('security-dialog').close(); $('password-form').reset(); });
bind('password-form', 'submit', async e => {
  e.preventDefault(); const button = e.target.querySelector('button[type=submit]'); button.disabled = true;
  try { await api('/password', 'POST', { currentPassword: $('current-password').value, newPassword: $('new-password').value, code: $('password-code').value }); window.location.reload(); }
  catch (error) { report(error, 'security-error'); }
  finally { button.disabled = false; }
});
function setBusy(busy) { sending = busy; $('send').disabled = busy; $('cancel').hidden = !busy; $('model').disabled = busy; }
async function enterWorkspace(user) {
  csrf = user.csrf; $('account-name').textContent = user.username; $('auth').hidden = true; $('workspace').hidden = false;
  document.querySelector('.sidebar-bottom').hidden = Boolean(user.localTrusted);
  $('auth-error').textContent = ''; await refreshChats();
  await refreshEngine();
}
async function refreshEngine() {
  const result = await api('/models');
  if (!activeRun) $('run-status').textContent = result.state === 'loading' ? 'Chargement du modèle…' : '';
}
async function refreshChats() { chats = await api('/chats'); renderChats(); }
function renderChats() {
  $('chat-list').replaceChildren();
  const search = $('chat-search').value.toLocaleLowerCase();
  for (const chat of chats.filter(item => item.title.toLocaleLowerCase().includes(search))) {
    const button = document.createElement('button'); button.textContent = chat.title; button.title = chat.title;
    button.className = current?.id === chat.id ? 'active' : '';
    button.addEventListener('click', () => loadChat(chat.id).catch(report)); $('chat-list').append(button);
  }
}
function renderMessages(messages) {
  $('messages').replaceChildren(); $('welcome').hidden = messages.length > 0;
  for (const message of messages) {
    const article = document.createElement('article'); article.className = `message ${message.role}`;
    if (message.role === 'assistant') {
      const label = document.createElement('div'); label.className = 'message-label';
      label.textContent = message.model === 'qwen' ? 'Qwen3.6 27B' : 'GPT-OSS 20B'; article.append(label);
    }
    // Text nodes only: model-generated HTML/URLs cannot execute scripts or load tracking images.
    const pieces = message.content.split('```');
    pieces.forEach((piece, index) => {
      const node = document.createElement(index % 2 ? 'code' : 'span'); node.textContent = piece; article.append(node);
    });
    $('messages').append(article);
  }
  $('conversation').scrollTop = $('conversation').scrollHeight;
}
async function loadChat(id) {
  pollGeneration++; current = await api(`/chats/${id}`); activeRun = null; $('chat-error').textContent = '';
  $('notes').value = current.notes; $('model').value = current.model; updateQuant(); renderMessages(current.messages); renderChats();
  $('sidebar').classList.remove('open'); setBusy(false);
  const latest = current.runs[0];
  if (latest && ['queued', 'running'].includes(latest.status)) { activeRun = latest.id; setBusy(true); void pollRun(latest.id, current.id, ++pollGeneration); }
  else if (latest?.error) $('chat-error').textContent = latest.error;
}
async function ensureChat() {
  if (!current) { const chat = await api('/chats', 'POST', { model: $('model').value }); current = { id: chat.id, notes: '' }; await refreshChats(); }
  return current.id;
}
function updateQuant() { $('model-quant').textContent = $('model').value === 'qwen' ? 'Q4_K_M' : 'MXFP4'; }
async function pollRun(id, chatId, generation) {
  if (generation !== pollGeneration) return;
  try {
    const run = await api(`/runs/${id}`);
    if (generation !== pollGeneration) return;
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      activeRun = null; setBusy(false); $('run-status').textContent = '';
      if (current?.id === chatId) await loadChat(chatId);
      await refreshChats(); return;
    }
    $('run-status').textContent = run.status === 'queued' ? 'En attente du moteur local…' : run.engine.state === 'loading' ? 'Chargement du modèle choisi… Le changement peut prendre un moment.' : 'Le Harness prépare la réponse…';
    setTimeout(() => { void pollRun(id, chatId, generation); }, 2000);
  } catch (error) {
    if (generation !== pollGeneration) return;
    report(error); $('run-status').textContent = 'Connexion interrompue. Nouvelle tentative…';
    setTimeout(() => { void pollRun(id, chatId, generation); }, 5000);
  }
}
bind('login-form', 'submit', async e => {
  e.preventDefault(); $('auth-error').textContent = '';
  const button = e.target.querySelector('button'); button.disabled = true;
  try { const user = await api('/login', 'POST', { username: $('username').value, password: $('password').value, code: $('code').value.trim() }); $('password').value = ''; $('code').value = ''; await enterWorkspace(user); }
  finally { button.disabled = false; }
});
bind('begin-setup', 'click', async () => { const data = await api('/setup/begin', 'POST', {}); $('qr').src = data.qr; $('totp-secret').textContent = data.secret; $('enrollment').hidden = false; $('begin-setup').hidden = true; });
bind('setup-form', 'submit', async e => {
  e.preventDefault();
  if ($('setup-password').value !== $('setup-confirm').value) throw new Error('Les mots de passe ne correspondent pas.');
  const button = e.target.querySelector('button[type=submit]'); button.disabled = true;
  try {
    const result = await api('/setup/finish', 'POST', { username: $('setup-username').value, password: $('setup-password').value, code: $('setup-code').value });
    $('setup-password').value = ''; $('setup-confirm').value = ''; $('qr').removeAttribute('src'); $('totp-secret').textContent = '';
    $('setup-form').hidden = true; $('recovery').hidden = false; $('recovery-codes').textContent = result.recoveryCodes.join('\n'); $('go-login').href = result.loginUrl; $('auth-error').textContent = '';
  } finally { button.disabled = false; }
});
bind('copy-recovery', 'click', async () => { await navigator.clipboard.writeText($('recovery-codes').textContent); $('copy-recovery').textContent = 'Codes copiés'; });
bind('new-chat', 'click', () => { current = null; activeRun = null; pollGeneration++; setBusy(false); $('notes').value = ''; $('notes-panel').hidden = true; $('chat-error').textContent = ''; $('run-status').textContent = ''; renderMessages([]); renderChats(); $('sidebar').classList.remove('open'); $('prompt').focus(); });
bind('chat-search', 'input', renderChats);
bind('model', 'change', async () => { updateQuant(); if (current) await api(`/chats/${current.id}`, 'PATCH', { model: $('model').value }); });
bind('menu-toggle', 'click', () => $('sidebar').classList.toggle('open'));
bind('notes-toggle', 'click', () => { $('notes-panel').hidden = !$('notes-panel').hidden; });
bind('save-notes', 'click', async () => { const id = await ensureChat(); await api(`/chats/${id}`, 'PATCH', { notes: $('notes').value }); $('notes-panel').hidden = true; $('run-status').textContent = 'Mémoire enregistrée.'; });
bind('delete-chat', 'click', async () => { if (current && window.confirm('Supprimer définitivement cette conversation et sa mémoire ?')) { await api(`/chats/${current.id}`, 'DELETE', {}); $('new-chat').click(); await refreshChats(); } });
bind('logout', 'click', async () => { await api('/logout', 'POST', {}); window.location.reload(); });
bind('logout-all', 'click', async () => { if (window.confirm('Déconnecter tous les appareils, y compris celui-ci ?')) { await api('/logout-all', 'POST', {}); window.location.reload(); } });
bind('cancel', 'click', async () => { if (activeRun) await api(`/runs/${activeRun}/cancel`, 'POST', {}); });
bind('composer', 'submit', async e => {
  e.preventDefault(); if (sending || !$('prompt').value.trim()) return;
  const content = $('prompt').value.trim(); $('chat-error').textContent = ''; setBusy(true);
  try {
    const id = await ensureChat(); const result = await api(`/chats/${id}/messages`, 'POST', { content, model: $('model').value });
    $('prompt').value = ''; await loadChat(id); activeRun = result.id; await refreshChats();
  } catch (error) { setBusy(false); throw error; }
});
bind('prompt', 'keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } });
async function init() {
  const state = await api('/bootstrap');
  if (state.setup && !state.initialized) { $('setup-form').hidden = false; if (!setupToken) { $('begin-setup').disabled = true; throw new Error('Ouvrez la configuration avec le raccourci local Harness Setup.'); } return; }
  if (state.setup && state.initialized) { $('uninitialized').hidden = false; $('uninitialized').querySelector('h2').textContent = 'Votre compte est prêt.'; $('uninitialized').querySelector('p').textContent = 'Ouvrez http://127.0.0.1:3082 pour retrouver vos conversations.'; return; }
  if (!state.initialized) { $('uninitialized').hidden = false; return; }
  try { await enterWorkspace(await api('/me')); } catch { showLogin(); }
}
void init().catch(error => report(error, 'auth-error'));
