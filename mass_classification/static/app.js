'use strict';
const $ = id => document.getElementById(id);
const state = {key: sessionStorage.getItem('massKey') || '', mode: 'production', role: 'reader', docs: [], selected: null, page: 'overview', connected: false};
const titles = {overview: 'Vue d’ensemble', documents: 'Documents', search: 'Recherche', graph: 'Relations', timeline: 'Chronologie', audit: 'Journal d’audit'};
const labels = {banking: 'Finance', finance: 'Finance', investigation: 'Enquête', enquete: 'Enquête', media: 'Média'};
const node = (tag, value = '', className = '') => {const item = document.createElement(tag); item.textContent = value; item.className = className; return item;};
const fmtDate = value => {try {return new Date(value).toLocaleDateString('fr-FR', {day:'2-digit', month:'short', year:'numeric'});} catch {return '—';}};
const shortName = value => value?.length > 37 ? value.slice(0, 34) + '…' : (value || 'Sans nom');
const canWrite = () => state.role === 'admin' || state.role === 'analyst';
function notice(value, type = 'success') {const box = $('notice'); box.textContent = value; box.className = `notice ${type}`; clearTimeout(notice.timer); notice.timer = setTimeout(() => box.classList.add('hidden'), 8500);}
function icon(filename) {const ext = (filename || '').split('.').pop().toLowerCase(); const item = node('span', ext.slice(0, 3).toUpperCase() || 'DOC', `file-icon ${['txt','csv','pdf'].includes(ext) ? ext : ''}`); item.setAttribute('aria-hidden','true'); return item;}
function badge(status) {const displayed = {ready:'Analysé', queued:'En attente', processing:'En cours', failed:'Échec'}; return node('span', displayed[status] || status, `status-badge ${status === 'ready' ? 'ready' : status === 'failed' ? 'failed' : 'pending'}`);}
async function api(path, options = {}) {
  const headers = {...(options.headers || {})};
  if (state.key) headers.Authorization = `Bearer ${state.key}`;
  let response;
  try {response = await fetch(path, {...options, headers, cache:'no-store'});} catch {throw new Error('Connexion impossible. Vérifiez que le serveur fonctionne.');}
  if (!response.ok) {let reason = response.statusText; try {reason = (await response.json()).detail || reason;} catch {} throw new Error(`${response.status} — ${reason}`);}
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.blob();
}
function setConnected(session) {
  state.mode = session.mode; state.role = session.role; state.connected = true;
  $('auth-overlay').classList.add('hidden');
  $('connection').classList.add('online'); $('connection').lastChild.textContent = ' Connecté';
  $('mode-pill').textContent = session.mode === 'demo' ? 'Mode découverte' : session.tenant;
  $('mode-pill').classList.toggle('demo', session.mode === 'demo');
  $('demo-ribbon').classList.toggle('hidden', session.mode !== 'demo');
  $('disconnect').classList.toggle('hidden', session.mode === 'demo');
  $('drop-hint').textContent = session.mode === 'demo' ? 'TXT, MD, CSV, TSV, JSON, EML · 5 Mio max' : 'Fichiers pris en charge · 50 Mio max';
  document.querySelectorAll('[data-action="open-upload"]').forEach(button => button.classList.toggle('hidden', !canWrite()));
  $('feedback').classList.toggle('hidden', !canWrite());
  $('csv').classList.toggle('hidden', !canWrite());
}
async function connect(withKey = state.key) {
  state.key = withKey;
  const session = await api('/v1/session');
  setConnected(session);
  await refresh();
}
function showPage(page) {
  if (!titles[page]) return;
  state.page = page; $('breadcrumb-current').textContent = titles[page];
  document.querySelectorAll('.page').forEach(item => item.classList.toggle('hidden', item.id !== page));
  document.querySelectorAll('[data-page]').forEach(item => {item.classList.toggle('active', item.dataset.page === page); item.setAttribute('aria-current', item.dataset.page === page ? 'page' : 'false');});
  $('sidebar').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded','false');
  if (page === 'graph') loadGraph();
  if (page === 'timeline') loadTimeline();
  if (page === 'audit') loadAudit();
  if (page === 'documents') renderDocuments();
  window.scrollTo({top:0, behavior:'smooth'});
}
function sourceText(doc) {const data = doc.source || {}; return data.description || data.title || data.case || data.type === 'synthetic_example' && 'Exemple fictif' || 'Non renseignée';}
async function refresh() {
  try {
    state.docs = await api('/v1/documents?limit=100');
    $('doc-count').textContent = state.docs.length;
    $('ready-count').textContent = state.docs.filter(d => d.status === 'ready').length;
    $('queued-count').textContent = state.docs.filter(d => ['queued','processing'].includes(d.status)).length;
    $('nav-count').textContent = state.docs.length;
    renderRecent(); renderDocuments();
  } catch (error) {notice(error.message, 'error');}
}
function empty(message) {const box = node('div', message, 'empty-table'); return box;}
function renderRecent() {
  const host = $('recent-list'); host.replaceChildren();
  if (!state.docs.length) {host.append(empty('Aucune pièce pour le moment. Importez votre premier document.')); return;}
  state.docs.slice(0, 4).forEach(doc => {
    const row = node('div', '', 'recent-item'); const info = node('div', '', 'recent-info');
    info.append(node('strong', shortName(doc.filename)), node('small', `${sourceText(doc)} · ${fmtDate(doc.created_at)}`));
    const action = node('div','', 'recent-actions'); action.append(badge(doc.status));
    const open = node('button','→','row-action'); open.type = 'button'; open.setAttribute('aria-label',`Ouvrir ${doc.filename}`); open.onclick = () => openDocument(doc.id);
    action.append(open); row.append(icon(doc.filename),info,action); host.append(row);
  });
}
function renderDocuments() {
  const filter = $('document-filter').value.trim().toLocaleLowerCase();
  const docs = state.docs.filter(doc => `${doc.filename} ${sourceText(doc)}`.toLocaleLowerCase().includes(filter));
  const body = $('documents-list'); body.replaceChildren();
  if (!docs.length) {const tr = node('tr'); const cell = node('td',state.docs.length ? 'Aucune pièce ne correspond à ce filtre.' : 'Aucune pièce pour le moment.','empty-table'); cell.colSpan = 5; tr.append(cell); body.append(tr); return;}
  docs.forEach(doc => {
    const tr = node('tr'); const file = node('td'); const name = node('div','','name-cell'); name.append(icon(doc.filename),node('strong',doc.filename)); file.append(name);
    const source = node('td',sourceText(doc),'source-cell'); const status = node('td'); status.append(badge(doc.status));
    const date = node('td',fmtDate(doc.created_at)); const last = node('td'); const open = node('button','Ouvrir →','table-open'); open.type='button'; open.onclick=()=>openDocument(doc.id); last.append(open);
    tr.append(file,source,status,date,last); body.append(tr);
  });
}
function closeOverlay(id) {$(id).classList.add('hidden');}
function openUpload() {if (!canWrite()) return; $('upload-error').classList.add('hidden'); $('upload-overlay').classList.remove('hidden'); $('file').focus();}
function infoValue(label, value) {const card=node('div','','signal-card'); card.append(node('span',label),node('strong',String(value)),node('small','Signal descriptif')); return card;}
async function openDocument(id) {
  try {
    const doc = await api(`/v1/documents/${id}`); state.selected = id;
    $('detail-title').textContent = doc.filename;
    $('detail-meta').textContent = `${id} · ${sourceText(doc)}`;
    const host = $('detail-content'); host.replaceChildren();
    const row = node('div','','info-strip'); row.append(badge(doc.status),node('small',doc.language ? `Langue : ${doc.language}` : 'Langue non détectée'));
    host.append(row);
    if (doc.error) host.append(node('p',doc.error,'notice error'));
    if (doc.analysis) {
      const analysis = doc.analysis;
      host.append(node('h3','Vue de l’analyse'));
      const grid = node('div','','signal-grid');
      grid.append(infoValue('Priorité de revue', `${analysis.labels?.review_priority ?? '—'} / 100`), infoValue('Montants repérés', analysis.signals?.money_mentions ?? '—'));
      host.append(grid);
      const scores = analysis.labels?.domain_scores || {};
      if (Object.keys(scores).length) {host.append(node('h3','Thèmes suggérés')); const tags=node('div','','tags'); Object.entries(scores).forEach(([key,value]) => tags.append(node('span',`${labels[key] || key} · ${Math.round(value*100)} %`,'tag'))); host.append(tags);}
      const prediction=analysis.predictions || {};
      if (prediction.status === 'unavailable') host.append(node('p','Aucun modèle prédictif approuvé n’est actif pour cette pièce. Les indications affichées proviennent de règles explicites.','explanation'));
      if (analysis.explanation?.limitations) host.append(node('p',analysis.explanation.limitations,'explanation'));
      const contributions=analysis.explanation?.priority_contributions;
      if (contributions) {host.append(node('h3','Pourquoi cette priorité ?'));const list=node('div','','explanation-bars');
        Object.entries(contributions).forEach(([name,value])=>{const line=node('div','','explanation-line');line.append(node('span',name.replaceAll('_',' ')),node('strong',`+${value}`));list.append(line);});host.append(list);
        if(state.mode==='production'){const more=node('button','Calculer les contributions SHAP →','table-open');more.type='button';more.onclick=async()=>{more.disabled=true;try{const explanation=await api(`/v1/documents/${id}/explanation`);const result=node('p',`SHAP (base ${explanation.baseline}) : ${Object.entries(explanation.contributions).map(([k,v])=>`${k} ${v>=0?'+':''}${v.toFixed(1)}`).join(' · ')}. ${explanation.limitations}`,'explanation');list.append(result);}catch(error){notice(error.message,'error');}finally{more.disabled=false;}};host.append(more);}
      }
    }
    host.append(node('h3','Contenu extrait'));
    host.append(node('div',doc.content || 'La pièce est encore en cours de traitement.','excerpt'));
    if (doc.content_truncated) host.append(node('p','Affichage limité aux premiers caractères. Consultez la pièce source dans votre système de conservation.','explanation'));
    $('detail-overlay').classList.remove('hidden'); $('detail-overlay').querySelector('[data-action="close-detail"]').focus();
  } catch(error) {notice(error.message,'error');}
}
async function loadGraph() {
  const host=$('graph-list'); host.replaceChildren(empty('Chargement des relations…'));
  try {
    const graph=await api('/v1/graph'); host.replaceChildren();
    if (!graph.edges.length) {host.append(empty('Aucune relation extraite. Ajoutez une pièce contenant un lien explicite pour en voir ici.')); return;}
    const names=Object.fromEntries(graph.nodes.map(n=>[n.id,n.canonical]));
    const shown=graph.nodes.slice(0,20), visible=new Set(shown.map(n=>n.id));
    if(shown.length>1){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 600 320');svg.setAttribute('role','img');svg.setAttribute('aria-label','Schéma des entités et relations, détails ci-dessous');svg.classList.add('graph-svg');
      const points=Object.fromEntries(shown.map((n,i)=>[n.id,{x:300+220*Math.cos(2*Math.PI*i/shown.length),y:160+120*Math.sin(2*Math.PI*i/shown.length)}]));
      const el=(tag,attrs)=>{const item=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs).forEach(([k,v])=>item.setAttribute(k,String(v)));svg.append(item);return item;};
      graph.edges.filter(e=>visible.has(e.source_id)&&visible.has(e.target_id)).slice(0,40).forEach(e=>el('line',{x1:points[e.source_id].x,y1:points[e.source_id].y,x2:points[e.target_id].x,y2:points[e.target_id].y,stroke:'#a9bacb','stroke-width':2}));
      shown.forEach(n=>{const p=points[n.id];el('circle',{cx:p.x,cy:p.y,r:7,fill:'#277e73'});const label=el('text',{x:p.x,y:p.y-13,'text-anchor':'middle',fill:'#213448','font-size':11});label.textContent=shortName(n.canonical).slice(0,22);});host.append(svg);}
    graph.edges.forEach(edge=>{
      const row=node('div','','relation-row'); const text=node('div','','relation-text');
      text.append(node('strong',`${names[edge.source_id] || 'Entité'} → ${edge.kind} → ${names[edge.target_id] || 'Entité'}`),node('small',`Source : ${edge.evidence}`));
      const open=node('button','Voir la pièce →','table-open'); open.type='button'; open.onclick=()=>openDocument(edge.document_id); row.append(text,open); host.append(row);
    });
  } catch(error) {host.replaceChildren(empty(error.message));}
}
async function loadTimeline(){const host=$('timeline-list');host.replaceChildren(empty('Chargement des dates…'));
  try{const events=await api('/v1/timeline');host.replaceChildren();if(!events.length){host.append(empty('Aucune pièce disponible.'));return;}
    events.forEach(event=>{const row=node('div','','timeline-item');const dot=node('span','','timeline-dot');dot.setAttribute('aria-hidden','true');const body=node('div','','timeline-body');body.append(node('small',`${fmtDate(event.at)} · ${event.date_kind==='source_event'?'Date déclarée par la source':'Date d’importation'}`),node('strong',event.filename));const open=node('button','Voir la pièce →','table-open');open.type='button';open.onclick=()=>openDocument(event.document_id);row.append(dot,body,open);host.append(row);});
  }catch(error){host.replaceChildren(empty(error.message));}}
async function loadAudit() {
  const host=$('audit-list'); host.replaceChildren(empty('Chargement du journal…'));
  try {
    const events=await api('/v1/audit'); host.replaceChildren();
    if (!events.length) {host.append(empty('Aucun événement pour le moment.')); return;}
    const actions={uploaded:'Import',viewed:'Consultation',reviewed:'Revue',searched:'Recherche',exported:'Export',processed:'Analyse terminée',processing_failed:'Analyse échouée'};
    events.forEach(entry=>{const row=node('div','','audit-row'); const text=node('div'); text.append(node('strong',actions[entry.action] || entry.action),node('small',entry.subject)); row.append(text,node('small',fmtDate(entry.created_at))); host.append(row);});
  } catch(error) {host.replaceChildren(empty(error.status === 403 ? 'Le journal nécessite un accès administrateur.' : error.message));}
}
async function runSearch(query) {
  const host=$('answer'); host.replaceChildren(empty('Recherche en cours…'));
  try {
    const matches=await api('/v1/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,limit:8})});
    host.replaceChildren();
    if (!matches.length) {host.append(empty('Aucun passage correspondant. Essayez des termes plus précis.')); return;}
    host.append(node('h2',`${matches.length} passage${matches.length>1?'s':''} retrouvé${matches.length>1?'s':''}`));
    matches.forEach(item=>{const card=node('article','','result-card'); const top=node('div','','result-top');
      top.append(node('strong',item.filename || 'Pièce'),node('small',`Segment ${item.ordinal+1} · score ${Math.round(Math.max(0,Math.min(1,item.similarity))*100)} %`));
      const excerpt=node('p',item.text); const button=node('button','Ouvrir la pièce et vérifier →'); button.type='button'; button.onclick=()=>openDocument(item.document_id);
      card.append(top,excerpt,button); host.append(card);
    });
  } catch(error) {host.replaceChildren(empty(error.message));}
}
async function download(path,filename) {try {const blob=await api(path); const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),2000);} catch(error) {notice(error.message,'error');}}
function bind() {
  document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>showPage(button.dataset.page)));
  document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>{
    const action=button.dataset.action;
    if(action==='open-upload')openUpload(); if(action==='close-upload')closeOverlay('upload-overlay'); if(action==='close-detail')closeOverlay('detail-overlay');
    if(action==='go-documents')showPage('documents'); if(action==='go-search')showPage('search');
  }));
  $('menu-toggle').onclick=()=>{const open=$('sidebar').classList.toggle('open'); $('menu-toggle').setAttribute('aria-expanded',String(open));};
  $('document-filter').addEventListener('input',renderDocuments);
  $('refresh').onclick=refresh;
  $('auth').onsubmit=async event=>{event.preventDefault();const key=$('token').value.trim();try{await connect(key);sessionStorage.setItem('massKey',key);$('token').value='';notice('Espace ouvert.');}catch(error){$('token').value='';const hint=$('auth').querySelector('.auth-error')||node('p','','auth-error');hint.textContent=error.message;$('auth').append(hint);}};
  $('disconnect').onclick=()=>{sessionStorage.removeItem('massKey');state.key='';state.connected=false;$('auth-overlay').classList.remove('hidden');$('token').focus();};
  $('ask').onsubmit=event=>{event.preventDefault();runSearch($('query').value.trim());};
  document.querySelectorAll('[data-query]').forEach(button=>button.onclick=()=>{$('query').value=button.dataset.query;showPage('search');runSearch(button.dataset.query);});
  const file=$('file'), zone=$('dropzone');
  file.onchange=()=>{$('drop-title').textContent=file.files[0]?.name || 'Glissez un fichier ici ou parcourez vos fichiers';};
  ['dragenter','dragover'].forEach(name=>zone.addEventListener(name,event=>{event.preventDefault();zone.classList.add('dragging');}));
  ['dragleave','drop'].forEach(name=>zone.addEventListener(name,event=>{event.preventDefault();zone.classList.remove('dragging');}));
  zone.addEventListener('drop',event=>{if(event.dataTransfer.files.length){const transfer=new DataTransfer();transfer.items.add(event.dataTransfer.files[0]);file.files=transfer.files;file.dispatchEvent(new Event('change'));}});
  $('upload').onsubmit=async event=>{event.preventDefault();const submit=$('upload-submit');submit.disabled=true;submit.textContent='Import en cours…';
    try {const form=new FormData(event.target);const source=String(form.get('source')||'').trim();form.delete('source');form.set('source_json',JSON.stringify(source?{description:source}:{}));
      const result=await api('/v1/documents',{method:'POST',body:form});closeOverlay('upload-overlay');event.target.reset();$('drop-title').textContent='Glissez un fichier ici ou parcourez vos fichiers';
      notice(result.duplicate?'Cette pièce existe déjà dans cet espace.':result.status==='ready'?'Pièce importée et analysée.':'Pièce importée. L’analyse se poursuit en arrière-plan.');await refresh();showPage('documents');
      if(result.status!=='ready') {let tries=0;const timer=setInterval(async()=>{tries++;await refresh();const current=state.docs.find(doc=>doc.id===result.id);if(!current||current.status==='ready'||current.status==='failed'||tries>=24){clearInterval(timer);if(current?.status==='ready')notice('Analyse terminée : la pièce est prête à être consultée.');}},5000);}
    } catch(error){$('upload-error').textContent=error.message;$('upload-error').classList.remove('hidden');} finally {submit.disabled=false;submit.textContent='Importer la pièce';}
  };
  $('feedback').onsubmit=async event=>{event.preventDefault();if(!state.selected)return;const form=new FormData(event.target);try {await api(`/v1/documents/${state.selected}/feedback`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:form.get('label'),accepted:form.get('accepted')==='true',comment:form.get('comment')})});notice('Revue enregistrée avec succès.');event.target.reset();}catch(error){notice(error.message,'error');}};
  $('csv').onclick=()=>download('/v1/exports/documents.csv','documents.csv');$('pdf').onclick=()=>state.selected&&download(`/v1/documents/${state.selected}/report.pdf`,`${state.selected}.pdf`);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeOverlay('upload-overlay');closeOverlay('detail-overlay');$('sidebar').classList.remove('open');}});
  ['upload-overlay','detail-overlay'].forEach(id=>$(id).addEventListener('click',event=>{if(event.target===$(id))closeOverlay(id);}));
}
async function init() {
  bind(); const requested=location.hash.slice(1);if(titles[requested])showPage(requested);
  try {await connect(state.key);} catch {state.connected=false;state.key='';sessionStorage.removeItem('massKey');$('auth-overlay').classList.remove('hidden');$('token').focus();}
  if('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/static/sw.js').catch(()=>{});
}
init();
