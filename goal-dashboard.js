/* Goal-only public dashboard. No changes to signal selection or settlement. */
(function () {
  'use strict';
  const categories = ['live', 'late', 'prelive', 'elite'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const number = value => value === null || value === '' || typeof value === 'boolean'
    ? NaN : Number(value);
  const result = r => ({green:'ganho', red:'perdido', win:'ganho', loss:'perdido'}[r] || r || 'pendente');
  const isLate = s => s.produto === 'late_goal' || /late\s*goal/i.test(s.mercado || '');
  function category(s) {
    if (/arquivo/i.test(s.estrategia || '')) return null;
    if (s.origem === 'manual' || s.estrategia === 'Sharp Pick') return 'elite';
    if (isLate(s)) return 'late';
    if (s.estrategia === 'Golos 2ª Parte' || s.produto === 'over2p') return 'live';
    return null; // Unknown products must not silently enter Goal accounts.
  }
  function ticketKey(b) {
    return [b.data, b.tipo, ...(b.pernas || []).map(p => p.fixture_id || `${p.casa}|${p.fora}`)].join('|');
  }
  function confirmed(b) {
    // Defence in depth for cached/old payloads: Goal delivery alone is private.
    // Missing audience evidence is not permission to show a ticket.
    return b?.publication_confirmed === true && b.free_publication_confirmed === true;
  }
  function tickets(d, fallback) {
    // Old scheduler processes may still publish the old payload until their normal
    // restart. Keep a verified public snapshot available, but never merge it over
    // an authoritative full history (including an intentionally empty history).
    const c = d.combinada || {};
    const authoritative = Array.isArray(c.historico);
    const rows = authoritative ? c.historico : [
      ...(fallback?.historico || []), ...(c.ultimos || []), ...(c.ultimo ? [c.ultimo] : [])
    ];
    const unique = new Map();
    for (const b of rows) if (confirmed(b)) unique.set(ticketKey(b), b);
    return [...unique.values()].map(b => ({...b, id:b.ticket_id || ticketKey(b), category:'prelive',
      resultado:result(b.resultado), units:number(b.u ?? 1), odd:number(b.odd), legs:b.pernas || [],
      published_at:b.published_at || b.publicacao?.publicado_em || '', hora:b.hora || ''}));
  }
  function normalize(d, fallback) {
    const unique = new Map();
    for (const s of d.historico_sinais || []) {
      const c = category(s);
      if (!c || s.conditional_signal) continue;
      // Legacy imported manual rows have no fixture ID and can share signal_id.
      // Preserve distinct games/times; only collapse truly identical records.
      const id = s.signal_id && s.fixture_id ? s.signal_id
        : [s.data,s.hora,s.estrategia,s.jogo,s.mercado,s.odd].join('|');
      unique.set(id, {...s, id, category:c, units:1, odd:number(s.odd), resultado:result(s.resultado)});
    }
    return [...unique.values(), ...tickets(d, fallback)];
  }
  const priced = s => Number.isFinite(s.odd) && s.odd > 1 && Number.isFinite(s.units) && s.units > 0;
  const settled = s => priced(s) && ['ganho','perdido','push'].includes(s.resultado);
  const profit = s => !settled(s) ? 0 : s.resultado === 'ganho' ? s.units * (s.odd - 1)
    : s.resultado === 'perdido' ? -s.units : 0;
  function stats(rows) {
    const decided = rows.filter(settled), wins = decided.filter(s => s.resultado === 'ganho').length;
    const losses = decided.filter(s => s.resultado === 'perdido').length;
    const stake = decided.reduce((n,s) => n + (s.resultado === 'push' ? 0 : s.units), 0);
    const pl = decided.reduce((n,s) => n + profit(s), 0);
    return {sinais:rows.length, ganhos:wins, perdidos:losses, lucro_u:pl,
      roi:stake ? pl / stake * 100 : 0, wr:wins+losses ? Math.round(wins/(wins+losses)*1000)/10 : 0,
      pendentes:rows.filter(s => !['ganho','perdido','push'].includes(s.resultado)).length,
      sem_preco:rows.filter(s => !priced(s)).length};
  }
  function tradingDay(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Lisbon',
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now)
      .filter(x => x.type !== 'literal').map(x => [x.type,x.value]));
    const day = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
    if (+p.hour < 6) day.setUTCDate(day.getUTCDate()-1);
    return day.toISOString().slice(0,10);
  }
  function stamp(s) {
    if (s.published_at && Number.isFinite(Date.parse(s.published_at))) return Date.parse(s.published_at);
    const day = Date.parse(s.data + 'T00:00:00Z'), t = /^(\d{2}):(\d{2})/.exec(s.hora || '');
    return Number.isFinite(day) ? day + (t ? ((+t[1] < 6 ? 24 : 0) + +t[1])*3600000 + +t[2]*60000 : 0) : 0;
  }
  function panel(rows, today) {
    const week = new Date(today+'T12:00:00Z');
    week.setUTCDate(week.getUTCDate()-((week.getUTCDay()+6)%7));
    const wi = week.toISOString().slice(0,10), month = today.slice(0,7)+'-01';
    const between = ini => stats(rows.filter(s => s.data >= ini && s.data <= today));
    const closed = rows.filter(settled).sort((a,b) => stamp(a)-stamp(b) || a.id.localeCompare(b.id));
    const daily = new Map(); let run = 0, best = 0;
    for (const s of closed) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(s.data)) daily.set(s.data, (daily.get(s.data) || 0)+profit(s));
      if (s.resultado !== 'push') run = s.resultado === 'ganho' ? run + 1 : 0;
      best = Math.max(best,run);
    }
    let cumulative = 0;
    const serie = [...daily].sort(([a],[b]) => a.localeCompare(b)).map(([data,pl]) =>
      ({data, lucro_acum:(cumulative += pl)}));
    const bestDay = [...daily].sort((a,b) => b[1]-a[1])[0];
    return {geral:stats(rows), diario:between(today), semanal:between(wi), mensal:between(month), serie,
      forma:closed.slice(-15).map(s => s.resultado), streak_atual:run, streak_melhor:best,
      maior_odd:Math.max(0,...closed.filter(s => s.resultado==='ganho').map(s => s.odd)),
      melhor_dia:bestDay?.[1] || 0, melhor_dia_data:bestDay?.[0],
      dias_verde_pct:daily.size ? Math.round([...daily.values()].filter(v=>v>0).length/daily.size*100) : 0};
  }
  function select(rows, key, financial = false) {
    return key === 'all' ? rows.filter(s => !financial || s.category !== 'prelive')
      : rows.filter(s => s.category === key);
  }
  const api = {category,isLate,ticketKey,tickets,normalize,stats,profit,priced,tradingDay,stamp,panel,select,esc};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  const pt = document.documentElement.lang.startsWith('pt');
  const tr = (a,b) => pt ? a : b;
  const labels = {all:tr('Todos','All'), live:tr('Live 2.ª parte','Live 2nd half'), late:'Late Goal',
    prelive:tr('Pré-live','Pre-live'), elite:tr('Elite / manual','Elite / manual')};
  const aliases = {Total:'all',LIVE:'live','Golos 2ª Parte':'live','Sharp Pick':'elite',
    'Combinada do Dia':'prelive','Pré-Live Grátis':'prelive',Late:'late'};
  const query = new URLSearchParams(location.search).get('strat');
  let active = categories.includes(query) ? query : aliases[query] || 'all', page = 1, fallback = null;
  const pageSize = 40, odds = n => Number.isFinite(n) && n > 1 ? n.toFixed(2) : '—';
  const badge = r => `<span class="badge ${r==='ganho'?'b-g':r==='perdido'?'b-p':r==='push'?'b-x':'b-w'}">${
    r==='ganho'?tr('GANHO','WIN'):r==='perdido'?tr('PERDIDO','LOSS'):r==='push'?'PUSH':tr('PENDENTE','PENDING')}</span>`;
  function dateCell(s) {
    if (s.published_at && Number.isFinite(Date.parse(s.published_at))) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Lisbon',
        year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
        .formatToParts(new Date(s.published_at)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
      return `${parts.year}-${parts.month}-${parts.day}<br><small>${parts.hour}:${parts.minute}</small>`;
    }
    return `${esc(s.data)}<br><small>${esc(s.hora)}</small>`;
  }
  function legs(b) {
    return b.legs.map(p => `<div class="ticket-leg"><div>${esc(p.casa)} vs ${esc(p.fora)}
      <small>${esc(p.hora || '')}${p.liga && !/^\d+$/.test(p.liga) ? ' · '+esc(p.liga) : ''}</small></div>
      <div>${esc(p.mercado || tr('Over 1,5 · 2.ª parte','Over 1.5 · 2nd half'))}
      <b class="gold">@ ${odds(number(p.odd))}</b> ${badge(result(p.resultado))}</div></div>`).join('');
  }
  function ticketName(b) { return b.legs.length === 1 ? tr('Simples','Single') : b.legs.length === 2 ? tr('Dupla','Double') : tr('Tripla','Treble'); }
  function history(rows) {
    const sorted = rows.slice().sort((a,b) => stamp(b)-stamp(a) || a.id.localeCompare(b.id));
    const pages = Math.max(1,Math.ceil(rows.length/pageSize)); page = Math.min(page,pages);
    const start = (page-1)*pageSize;
    return `<div class="tblhint">${rows.length} ${tr('registos','records')} · ${tr('Página','Page')} ${page}/${pages}
      <span>${tr('No telemóvel, desliza a tabela →','On mobile, swipe the table →')}</span></div>
      <div class="card tbl"><table><thead><tr>${[tr('Data','Date'),tr('Produto','Product'),tr('Liga','League'),
        tr('Jogo / bilhete','Match / ticket'),tr('Mercado','Market'),'Odd',tr('Resultado','Result')].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${
        sorted.slice(start,start+pageSize).map(s => {
          const ticket = s.category === 'prelive';
          const name = ticket ? `<details><summary>${ticketName(s)} · ${s.legs.length} ${s.legs.length===1?tr('jogo','match'):tr('jogos','matches')}</summary>${legs(s)}</details>` : esc(s.jogo);
          const product = ticket ? labels.prelive : s.category==='elite' ? (isLate(s)?'Late Goal':'Elite') : labels[s.category];
          return `<tr><td class="date-cell">${dateCell(s)}</td><td><span class="product product-${s.category}">${product}</span>
            <small>${s.category==='elite'?tr('Elite · Manual','Elite · Manual'):ticket?tr('Bilhete Pré-live','Pre-live ticket'):tr('Bot · Ao vivo','Bot · Live')}</small></td>
            <td>${ticket ? tr('Várias / ver jogos','See matches') : esc(s.liga)}</td><td>${name}</td>
            <td>${ticket ? tr('Combinada / simples pré-jogo','Pre-match accumulator / single') : esc(s.mercado)}</td>
            <td class="gold">${odds(s.odd)}</td><td>${badge(s.resultado)}</td></tr>`;
        }).join('') || `<tr><td colspan="7">${tr('Sem registos nesta categoria.','No records in this category.')}</td></tr>`}</tbody></table></div>
      <div class="pager"><button class="btn" data-page="${page-1}" ${page===1?'disabled':''}>${tr('Anterior','Previous')}</button>
      <span>${rows.length?start+1:0}–${Math.min(start+pageSize,rows.length)} / ${rows.length}</span>
      <button class="btn" data-page="${page+1}" ${page===pages?'disabled':''}>${tr('Seguinte','Next')}</button></div>`;
  }
  function ticketCard(all, today) {
    const ts = select(all,'prelive'), st = stats(ts), latest = ts.slice().sort((a,b)=>stamp(b)-stamp(a))[0];
    const dayTickets = latest ? ts.filter(b=>b.data===latest.data).sort((a,b)=>(a.ticket_slot||1)-(b.ticket_slot||1)) : [];
    return `<div class="sec-t">${tr('Pré-live · contas separadas','Pre-live · separate accounts')}</div>
      <div class="card tipday">${dayTickets.length ? dayTickets.map(b=>`<div class="hd"><b>${ticketName(b)}${dayTickets.length>1?` · #${b.ticket_slot||dayTickets.indexOf(b)+1}`:''}</b><span class="free">${
        tr('Publicado no gratuito','Shared in the free channel')}</span></div>
        ${legs(b)}<div class="tiprow"><span>${esc(b.data)} · 1u · ${tr('Odd do bilhete','Ticket odds')} <b class="gold">${odds(b.odd)}</b></span>${badge(b.resultado)}</div>`).join('')
        : `<p class="scope-note">${tr('Ainda não há bilhetes publicados disponíveis.','No published tickets available yet.')}</p>`}
      <div class="ticket-summary"><span>${st.sinais} ${tr('bilhetes','tickets')} · ✅ ${st.ganhos} · ❌ ${st.perdidos}
      · <b class="${cls(st.lucro_u)}">${f2(st.lucro_u)}u</b></span>
      <button class="btn" data-filter="prelive">${tr('Ver histórico Pré-live','View Pre-live history')}</button></div>
      <p class="scope-note">${tr('Aqui aparecem apenas os bilhetes publicados no canal gratuito: até um por dia, 1u por bilhete. Pode haver dias sem seleção.','Only tickets published in the free channel appear here: up to one per day, 1u per ticket. Some days may have no selection.')}</p></div>`;
  }
  function productCards(rows) {
    return categories.map(key => { const st=stats(select(rows,key));
      return `<button class="est" data-filter="${key}"><div class="e-top"><span class="e-name">${labels[key]}</span>
        <span class="e-n">${st.sinais} ${key==='prelive'?tr('bilhetes','tickets'):tr('sinais','signals')}</span></div>
        <div class="bar"><div style="width:${st.wr}%"></div></div><div class="e-bot"><span>✅ ${st.ganhos} ❌ ${st.perdidos}
        · ${st.wr.toFixed(1)}%</span><strong class="${cls(st.lucro_u)}">${f2(st.lucro_u)}u</strong></div></button>`;
    }).join('');
  }
  function render() {
    const rows=normalize(DATA,fallback), financial=select(rows,active,true), visible=select(rows,active);
    const today=tradingDay(), p=panel(financial,today), pre=active==='prelive';
    const title=active==='all'?tr('Ao vivo + Elite','Live + Elite'):labels[active];
    const conditionals=(DATA.historico_condicionais || []).filter(s=>category(s) && (active==='all' || category(s)===active)).length;
    const partialPrelive = !Array.isArray(DATA.combinada?.historico) && !Array.isArray(fallback?.historico);
    document.getElementById('brand').textContent='GOAL SHARP ELITE';
    document.getElementById('tag').textContent=DATA.marca?.tagline || 'Live Goal Intelligence';
    document.getElementById('upd').textContent=tr('Dados atualizados: ','Data updated: ')+(DATA.atualizado || '').replace('T',' ');
    document.getElementById('app').innerHTML=`<div class="segwrap"><div class="segs" aria-label="${tr('Filtrar produto','Filter product')}">
      ${['all',...categories].map(k=>`<button class="seg ${k===active?'on':''}" aria-pressed="${k===active}" data-filter="${k}">${labels[k]}</button>`).join('')}</div></div>
      <div class="scope-head"><h2>${title}</h2><p>${active==='all'
        ? tr('Totais de Live 2.ª parte, Late Goal e Elite/manual. Pré-live à parte; histórico conjunto abaixo.',
             'Totals for Live 2nd half, Late Goal and Elite/manual. Pre-live separate; combined history below.')
        : pre ? tr('Apenas bilhetes confirmados no canal gratuito. Contas separadas; cada bilhete conta uma vez.',
                   'Only tickets confirmed in the free channel. Separate accounts; each ticket counts once.')
        : active==='elite' ? tr('Entradas manuais, incluindo Late Goal enviado para o Elite.','Manual entries, including Late Goal sent to Elite.')
        : tr('Sinais automáticos do bot. Entradas manuais estão no Elite.','Automatic bot signals. Manual entries are under Elite.')}</p></div>
      ${(partialPrelive||DATA.combinada?.indisponivel)&&(pre||active==='all')?`<p class="scope-note">${tr('Histórico Pré-live temporariamente indisponível ou incompleto.','Pre-live history temporarily unavailable or incomplete.')}</p>`:''}
      <div id="kpis">${kpisFor(p.geral).replace(pre?(pt?'Sinais':'Signals'):'__never__',tr('Bilhetes','Tickets'))}</div>
      <p class="scope-note accounting">${tr('Resultado teórico às odds registadas; não comprova apostas executadas.','Theoretical results at recorded odds; not proof of executed bets.')}
      ${conditionals ? `${conditionals} ${tr('condicionais sem preço confirmado fora destas contas.','conditionals without confirmed odds excluded from these accounts.')}` : ''}
      ${p.geral.sem_preco ? `${p.geral.sem_preco} ${tr('registos sem preço válido excluídos de P/L e acerto.','records without valid odds excluded from P/L and win rate.')}` : ''}</p>
      ${formCard(p)}${periodsFor(p).replaceAll(pre?(pt?'sinais':'signals'):'__never__',tr('bilhetes','tickets'))}
      <p class="scope-note">${tr('Dia de atividade:','Activity day:')} ${today} · 06:00–06:00 Europe/Lisbon</p>
      <div class="sec-t" id="banca">${tr('Evolução em unidades','Cumulative units')} — ${title}</div>${chart(p.serie)}
      ${active==='all'||pre?ticketCard(rows,today):''}
      <div class="sec-t" id="estrat">${tr('Resultados por produto','Results by product')}</div><div class="grid estrats">${productCards(rows)}</div>
      <div class="sec-t" id="hist">${tr('Histórico','History')} — ${active==='all'?tr('todos os produtos','all products'):labels[active]}</div>${history(visible)}
      <p class="scope-note">${tr('O antigo arquivo de Golos e os bilhetes legados não integram esta vista nem os seus totais. Os registos originais foram preservados.',
        'The old Goals archive and legacy tickets are outside this view and its totals. Original records are preserved.')}</p>`;
    document.querySelectorAll('[data-filter]').forEach(el=>el.addEventListener('click',()=>{
      active=el.dataset.filter;page=1; const url=new URL(location.href);url.searchParams.set('strat',active);
      window.history.replaceState(null,'',url);render();
    }));
    document.querySelectorAll('[data-page]').forEach(el=>el.addEventListener('click',()=>{
      page=+el.dataset.page;render();document.getElementById('hist').scrollIntoView({block:'start'});
    }));
    document.querySelectorAll('.langswitch a').forEach(a=>{const url=new URL(a.href);url.searchParams.set('strat',active);a.href=url.href;});
    runAnims();document.querySelectorAll('.reveal').forEach(el=>el.classList.add('in'));
  }
  stakeEl.addEventListener('input',()=>{STAKE=Math.min(1000000,Math.max(1,Number(stakeEl.value)||1));if(DATA)render();});
  async function load() {
    try {
      const r=await fetch('dashboard.json?'+Date.now(),{cache:'no-store'});
      if(!r.ok) throw new Error('dashboard unavailable');
      DATA=await r.json();
      if(!Array.isArray(DATA.historico_sinais)) throw new Error('invalid dashboard');
      if(!Array.isArray(DATA.combinada?.historico)) {
        try {const r=await fetch('goal-prelive-history.json?v=20261011-free-only',{cache:'no-store'});if(r.ok)fallback=await r.json();} catch (_) { /* only verified free tickets may remain visible */ }
      }
      render();
    } catch (_) {
      document.getElementById('app').innerHTML=`<div class="err">${tr('Não foi possível carregar os resultados. Tenta atualizar a página.','Results could not be loaded. Please refresh the page.')}</div>`;
    }
  }
  load();
})();
