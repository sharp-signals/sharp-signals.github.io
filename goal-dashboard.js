/* Goal-only public dashboard. No changes to signal selection or settlement. */
(function () {
  'use strict';
  const categories = ['live', 'late', 'prelive', 'elite'];
  const preliveStart = '2026-11-06'; // First confirmed PDF-origin publications, not installation date.
  const preliveViews = ['pdf', 'archive', 'complete'];
  function scopePrelive(rows, view = 'pdf') {
    if (!preliveViews.includes(view)) view = 'pdf';
    return rows.filter(s => {
      if (s.category !== 'prelive' || view === 'complete') return true;
      const current = /^\d{4}-\d{2}-\d{2}$/.test(s.data || '') && s.data >= preliveStart;
      return view === 'pdf' ? current : !current;
    });
  }
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
    if (typeof b.ticket_id === 'string' && b.ticket_id) return b.ticket_id;
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
    const accounting = d.prelive_resultados;
    if (accounting?.publication_scope === 'all_confirmed_accounting_v1' &&
        Array.isArray(accounting.historico) && !accounting.indisponivel) {
      const unique = new Map();
      for (const b of accounting.historico) {
        if (b.publication_confirmed !== true || b.accounting_confirmed !== true ||
            !b.ticket_id || !['goal','free'].includes(b.publication_channel)) continue;
        if (b.publication_channel === 'free' && !confirmed(b)) continue;
        if (b.publication_channel === 'goal' &&
            (b.free_publication_confirmed !== false ||
             (b.legs_disclosed === false ? (b.pernas || []).length !== 0 :
              b.legs_disclosed !== true || !(b.pernas || []).length ||
              b.pernas.some(p=>!['ganho','perdido','push'].includes(p.resultado))))) continue;
        unique.set(ticketKey(b), b);
      }
      return [...unique.values()].map(b => ({...b, id:ticketKey(b), category:'prelive',
        resultado:result(b.resultado), units:number(b.u ?? 1), odd:number(b.odd),
        legs:b.pernas || [], published_at:b.published_at || '', hora:b.hora || ''}));
    }
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
    const quoted = rows.filter(priced);
    return {sinais:rows.length, ganhos:wins, perdidos:losses, lucro_u:pl,
      odd_media:quoted.length ? quoted.reduce((n,s)=>n+s.odd,0)/quoted.length : null,
      odd_media_n:quoted.length,
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
  function publicSummary(data) {
    if (!data || !Array.isArray(data.historico_sinais)) return null;
    const rows=select(scopePrelive(normalize(data)),'all',true), g=stats(rows);
    const dates=rows.map(s=>s.data).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')).sort();
    return {...g,start:dates[0]||null,end:dates.at(-1)||null,
      settled:rows.filter(settled).length};
  }
  function manualMarkets(rows) {
    const groups=new Map();
    for(const s of rows.filter(s=>s.category==='elite')) {
      // Keep the published market and line; never infer a half from product or score.
      let market=String(s.mercado||'').trim().replace(/\s+/g,' ') || '—';
      market=market.replace(/(\d),(\d)/g,'$1.$2');
      if(isLate(s) && !/late\s*goal/i.test(market)) market='Late Goal · '+market;
      if(!groups.has(market))groups.set(market,[]);
      groups.get(market).push(s);
    }
    return [...groups].sort(([a],[b])=>a.localeCompare(b,'pt',{numeric:true}))
      .map(([market,items])=>({market,...stats(items)}));
  }
  function manualKind(s) {
    if(isLate(s))return 'late';
    const market=String(s.mercado||'').trim();
    if(/^over\b/i.test(market) && /2[.ªaº°\s-]*(parte|half)|2nd half/i.test(market))return 'over_2h';
    if(/^over\s+\d+(?:[.,]\d+)?\s+FT$/i.test(market))return 'over_ft';
    // produto=over2p is a legacy exporter default, NOT evidence of a 2H market.
    return 'other';
  }
  function selectManual(rows,key='all') {
    return rows.filter(s=>s.category==='elite' && (key==='all'||manualKind(s)===key));
  }
  function monthRows(rows,month='all') {
    return month==='all'?rows:rows.filter(s=>String(s.data||'').slice(0,7)===month);
  }
  function monthlyStats(rows) {
    const groups=new Map();
    for(const s of rows)if(/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(s.data||'')){
      const month=s.data.slice(0,7);if(!groups.has(month))groups.set(month,[]);groups.get(month).push(s);
    }
    return [...groups].sort(([a],[b])=>b.localeCompare(a)).map(([month,r])=>({month,...stats(r)}));
  }
  function equitySeries(rows) {
    const daily=new Map();
    for(const s of rows.filter(settled))if(/^\d{4}-\d{2}-\d{2}$/.test(s.data||'')){
      if(!daily.has(s.data))daily.set(s.data,[]);daily.get(s.data).push(s);
    }
    let total=0;
    return [...daily].sort(([a],[b])=>a.localeCompare(b)).map(([data,items])=>{
      const g=stats(items);return {data,lucro_acum:(total+=g.lucro_u),delta:g.lucro_u,sinais:g.sinais,ganhos:g.ganhos,perdidos:g.perdidos};
    });
  }
  function cumulativeChart(serie, {pt=true,stake=10,width=1000}={}) {
    const points=(serie||[]).filter(p=>Number.isFinite(p.lucro_acum)&&/^\d{4}-\d{2}-\d{2}$/.test(p.data||''));
    if(!points.length)return `<div class="card chart"><p class="scope-note">${pt?'Sem resultados apurados para traçar o gráfico.':'No settled results to plot.'}</p></div>`;
    const W=Math.max(300,Math.min(1100,Number(width)||1000)), H=290, L=62,R=18,T=24,B=48;
    const ys=points.map(p=>p.lucro_acum), lo=Math.min(0,...ys),hi=Math.max(0,...ys);
    const raw=(hi-lo||1)/4,base=10**Math.floor(Math.log10(raw));
    const step=[1,2,2.5,5,10].map(n=>n*base).find(n=>n>=raw);
    const mn=Math.floor(lo/step)*step,mx=hi===lo?mn+step*4:Math.ceil(hi/step)*step;
    const times=points.map(p=>Date.parse(p.data+'T00:00:00Z')),span=times.at(-1)-times[0];
    const x=i=>L+(span?(times[i]-times[0])/span:0)*(W-L-R),y=v=>H-B-(v-mn)*(H-T-B)/(mx-mn);
    const fmt=v=>(v>0?'+':'')+v.toLocaleString(pt?'pt-PT':'en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
    const axis=v=>(Math.abs(v)<step/1000?'0':v.toLocaleString(pt?'pt-PT':'en-GB',{maximumFractionDigits:Math.max(1,-Math.floor(Math.log10(step))+1)}))+'u';
    const ticks=[];for(let v=mn;v<=mx+step/1000;v+=step)ticks.push(v);
    const grid=ticks.map(v=>`<g class="chart-tick"><line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="${Math.abs(v)<step/1000?'#c9a227':'#31405a'}" stroke-dasharray="${Math.abs(v)<step/1000?'0':'3 5'}"/><text x="${L-10}" y="${y(v)+4}" text-anchor="end" fill="#c5ccda" font-size="12">${axis(v)}</text></g>`).join('');
    const date=d=>`${d.slice(8,10)}/${d.slice(5,7)}/${d.slice(2,4)}`;
    const middle=times.reduce((best,t,i)=>Math.abs(t-times[0]-span/2)<Math.abs(times[best]-times[0]-span/2)?i:best,0);
    const indices=[...new Set([0,...(W>=600&&x(middle)>L+100&&x(middle)<W-R-100?[middle]:[]),points.length-1])];
    const dates=indices.map(i=>`<text x="${x(i)}" y="${H-18}" text-anchor="${i===0?'start':i===points.length-1?'end':'middle'}" fill="#c5ccda" font-size="12">${date(points[i].data)}</text>`).join('');
    const path=points.map((p,i)=>`${x(i)},${y(p.lucro_acum)}`).join(' '),last=ys.at(-1);
    const summary=`${pt?'Saldo acumulado':'Cumulative balance'}: ${fmt(last)}u · ${date(points[0].data)} – ${date(points.at(-1).data)}`;
    return `<div class="card chart"><div class="chart-caption"><span>${pt?'Saldo acumulado · unidades':'Cumulative balance · units'}</span><strong class="${last<0?'neg':'pos'}">${fmt(last)}u</strong></div>
      <div class="chart-plot"><svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(summary)}"><title>${esc(summary)}</title>
      ${grid}<polygon points="${x(0)},${y(0)} ${path} ${x(points.length-1)},${y(0)}" fill="#c9a227" opacity=".08"/>
      <polyline points="${path}" fill="none" stroke="#e8c96e" stroke-width="2.5" stroke-linejoin="round"/>
      ${points.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p.lucro_acum)}" r="${points.length===1?4:3}" fill="#e8c96e"/>`).join('')}${dates}
      <line class="chart-cursor" x1="0" x2="0" y1="${T}" y2="${H-B}" stroke="#f8f4ed" stroke-dasharray="3 4" visibility="hidden"/>
      ${points.map((p,i)=>{const left=i?(x(i-1)+x(i))/2:L,right=i<points.length-1?(x(i)+x(i+1))/2:W-R;
        return `<rect class="chart-hit" x="${left}" y="${T}" width="${Math.max(1,right-left)}" height="${H-T-B}" fill="transparent" tabindex="0" role="button" data-point="${i}" data-x="${x(i)}" aria-label="${esc(date(p.data)+': '+fmt(p.lucro_acum)+'u')}"><title>${date(p.data)}: ${fmt(p.lucro_acum)}u</title></rect>`;}).join('')}
      </svg><div class="chart-tooltip" role="status" aria-live="polite" hidden></div></div>
      <p class="scope-note">${pt?'Passa o rato, toca ou usa Tab nos pontos para ver a data e o P/L. Linha horizontal dourada = 0u.':'Hover, tap or tab through points to see the date and P/L. Horizontal gold line = 0u.'} ${pt?'Conversão ilustrativa':'Illustrative conversion'}: ${fmt(last*stake)}€ @ ${stake}€/u.</p></div>`;
  }
  function bindChart(root,series,{pt=true,stake=10}={}) {
    if(!root)return;
    const tip=root.querySelector('.chart-tooltip'),cursor=root.querySelector('.chart-cursor');
    if(!tip||!cursor)return;
    const fmt=n=>(n>=0?'+':'')+n.toLocaleString(pt?'pt-PT':'en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
    const hide=()=>{tip.hidden=true;cursor.setAttribute('visibility','hidden');};
    root.querySelectorAll('.chart-hit').forEach(hit=>{
      const show=e=>{
        const p=series[Number(hit.dataset.point)];if(!p)return;
        const label=p.data.split('-').reverse().join('/');
        tip.innerHTML=`<b>${esc(label)}</b><div>${pt?'P/L acumulado do período':'Cumulative period P/L'}</div><strong class="${p.lucro_acum<0?'neg':'pos'}">${fmt(p.lucro_acum)}u · ${fmt(p.lucro_acum*stake)}€</strong><div>${pt?'P/L do dia':'Day P/L'}: ${fmt(p.delta||0)}u · ${fmt((p.delta||0)*stake)}€</div><small>${p.sinais||0} ${pt?'entradas':'entries'} · ${p.ganhos||0}G / ${p.perdidos||0}R · ${stake}€/u</small>`;
        tip.hidden=false;
        const box=root.getBoundingClientRect(),point=hit.getBoundingClientRect();
        const x=Number.isFinite(e?.clientX)?e.clientX-box.left:point.left-box.left+point.width/2;
        tip.style.left=Math.max(6,Math.min(box.width-tip.offsetWidth-6,x+12))+'px';
        cursor.setAttribute('x1',hit.dataset.x);cursor.setAttribute('x2',hit.dataset.x);cursor.setAttribute('visibility','visible');
      };
      for(const event of ['pointerenter','pointermove','focus','click'])hit.addEventListener(event,show);
      hit.addEventListener('keydown',e=>{if(e.key==='Escape')hide();if(e.key==='Enter'||e.key===' '){e.preventDefault();show(e);}});
      hit.addEventListener('blur',hide);
    });
    root.addEventListener('pointerleave',hide);
  }
  const api = {category,isLate,ticketKey,tickets,normalize,stats,profit,priced,tradingDay,stamp,panel,select,esc,scopePrelive,preliveStart,publicSummary,manualMarkets,manualKind,selectManual,monthRows,monthlyStats,equitySeries,cumulativeChart,bindChart};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  window.GoalMetrics=api;
  if(!document.getElementById('app') || !document.getElementById('stake'))return;

  const pt = document.documentElement.lang.startsWith('pt');
  const tr = (a,b) => pt ? a : b;
  const labels = {all:tr('Todos','All'), live:tr('Live 2.ª parte','Live 2nd half'), late:'Late Goal',
    prelive:tr('Pré-live','Pre-live'), elite:tr('Elite / manual','Elite / manual')};
  const aliases = {Total:'all',LIVE:'live','Golos 2ª Parte':'live','Sharp Pick':'elite',
    'Combinada do Dia':'prelive','Pré-Live Grátis':'prelive',Late:'late'};
  const query = new URLSearchParams(location.search).get('strat');
  let active = categories.includes(query) ? query : aliases[query] || 'all', page = 1, fallback = null;
  const requestedView = new URLSearchParams(location.search).get('prelive_scope');
  let preliveView = preliveViews.includes(requestedView) ? requestedView : 'pdf';
  const manualKeys=['all','over_ft','over_2h','late','other'];
  const manualLabels={all:tr('Todos os mercados','All markets'),over_ft:'Over FT',over_2h:tr('Over 2.ª parte','2nd-half Over'),late:'Late Goal',other:tr('Outros · histórico','Other · history')};
  const params=new URLSearchParams(location.search);
  let eliteMarket=manualKeys.includes(params.get('elite_market'))?params.get('elite_market'):'all';
  let period=/^\d{4}-(0[1-9]|1[0-2])$/.test(params.get('month')||'')?params.get('month'):'all';
  const monthLabel=m=>new Intl.DateTimeFormat(pt?'pt-PT':'en-GB',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(m+'-01T12:00:00Z'));
  function manualControls(rows) {
    const keys=manualKeys.filter(k=>k==='all'||selectManual(rows,k).length);
    return `<div class="manual-controls"><div class="segs" aria-label="${tr('Mercados Elite','Elite markets')}">${keys.map(k=>`<button class="seg ${eliteMarket===k?'on':''}" data-manual="${k}" aria-pressed="${eliteMarket===k}">${manualLabels[k]}</button>`).join('')}</div>
      <p class="scope-note">${tr('O filtro altera indicadores, gráfico e histórico. Over FT conserva a linha registada; só classificamos como Late quando existe essa identificação.','This filter changes the metrics, chart and history. Over FT retains the recorded line; only identified Late entries are classified as Late.')}</p></div>`;
  }
  function monthControls(months) {
    return `<div class="chart-controls"><label for="chart-month">${tr('Período','Period')}</label><select id="chart-month"><option value="all" ${period==='all'?'selected':''}>${tr('Histórico completo','Full history')}</option>${months.map(m=>`<option value="${m.month}" ${period===m.month?'selected':''}>${monthLabel(m.month)}</option>`).join('')}</select>
      <span>${period==='all'?tr('Acumulado de todo o período','Full-period cumulative P/L'):tr('Acumulado do mês, a partir de 0u','Monthly cumulative P/L, starting from 0u')}</span></div>`;
  }
  function monthlyCards(months) {
    return `<section id="monthly-performance"><div class="sec-t">${tr('Performance por mês','Monthly performance')}</div><div class="monthly-grid">${months.map(m=>`<button class="month-card ${period===m.month?'on':''}" data-month="${m.month}" aria-pressed="${period===m.month}"><span>${monthLabel(m.month)}</span><strong class="${cls(m.lucro_u)}">${f2(m.lucro_u)}u</strong><small>${m.sinais} ${tr('entradas','entries')} · ${m.ganhos}G / ${m.perdidos}R</small><small>${tr('Acerto','Win rate')} ${m.ganhos+m.perdidos?m.wr.toFixed(1)+'%':'—'} · ROI ${m.ganhos+m.perdidos?f1(m.roi)+'%':'—'}</small><small>${tr('Odd média','Avg odds')} ${odds(m.odd_media)}${m.pendentes?' · '+m.pendentes+' '+tr('pendentes','pending'):''}</small></button>`).join('')||`<p class="scope-note">${tr('Sem meses com registos.','No months with records.')}</p>`}</div></section>`;
  }
  function syncURL() {
    const u=new URL(location.href);u.searchParams.set('strat',active);
    if(active==='prelive'&&preliveView!=='pdf')u.searchParams.set('prelive_scope',preliveView);else u.searchParams.delete('prelive_scope');
    if(active==='elite'&&eliteMarket!=='all')u.searchParams.set('elite_market',eliteMarket);else u.searchParams.delete('elite_market');
    if(period!=='all')u.searchParams.set('month',period);else u.searchParams.delete('month');
    window.history.replaceState(null,'',u);
  }
  const viewLabel = view => view === 'archive' ? tr('Pré-live · arquivo anterior a 06/11/2026','Pre-live · archive before 06 Nov 2026')
    : view === 'complete' ? tr('Pré-live · histórico completo','Pre-live · full history')
    : tr('Pré-live · versão atual — desde 06/11/2026','Pre-live · current version — since 06 Nov 2026');
  function preliveScopeControls(all, view) {
    const current = stats(select(scopePrelive(all, 'pdf'), 'prelive'));
    const archived = stats(select(scopePrelive(all, 'archive'), 'prelive'));
    return `<div class="card"><div class="segs" aria-label="${tr('Período do Pré-live','Pre-live period')}">${preliveViews.map(v=>
      `<button class="seg ${v===view?'on':''}" data-prelive-scope="${v}" aria-pressed="${v===view}">${v==='pdf'?tr('Versão atual','Current version'):v==='archive'?tr('Arquivo anterior','Earlier archive'):tr('Histórico completo','Full history')}</button>`).join('')}</div>
      <p class="scope-note">${tr('Versão atual desde 06/11/2026. As versões anteriores continuam no arquivo, com ganhos, perdas e pendentes.','Current version since 06 Nov 2026. Earlier versions remain in the archive, including wins, losses and pending tickets.')}</p>
      <p class="scope-note">${tr('Versão atual','Current version')}: ${current.sinais} ${tr('bilhetes','tickets')} · ${f2(current.lucro_u)}u.
      ${tr('Arquivo anterior','Earlier archive')}: ${archived.sinais} ${tr('bilhetes','tickets')} · ${f2(archived.lucro_u)}u · ${archived.pendentes} ${tr('pendentes','pending')}.</p></div>`;
  }
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
    if (b.legs_disclosed === false) return `<p class="scope-note">${tr(
      'Bilhete Goal confirmado. Os jogos ficam visíveis depois de todas as pernas estarem resolvidas.',
      'Confirmed Goal ticket. Matches become visible once all legs are settled.')}</p>`;
    return b.legs.map(p => `<div class="ticket-leg"><div>${esc(p.casa)} vs ${esc(p.fora)}
      <small>${esc(p.hora || '')}${p.liga && !/^\d+$/.test(p.liga) ? ' · '+esc(p.liga) : ''}</small></div>
      <div>${esc(p.mercado || tr('Over 1,5 · 2.ª parte','Over 1.5 · 2nd half'))}
      <b class="gold">@ ${odds(number(p.odd))}</b> ${badge(result(p.resultado))}</div></div>`).join('');
  }
  function legCount(b) { return b.leg_count ?? b.legs.length; }
  function ticketName(b) { return legCount(b) === 1 ? tr('Simples','Single') : legCount(b) === 2 ? tr('Dupla','Double') : tr('Tripla','Treble'); }
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
          const name = ticket ? `<details><summary>${ticketName(s)}${s.ticket_slot ? ' · #'+esc(s.ticket_slot) : ''} · ${legCount(s)} ${legCount(s)===1?tr('jogo','match'):tr('jogos','matches')}</summary>${legs(s)}</details>` : esc(s.jogo);
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
  function ticketCard(all, today, view) {
    const ts = select(all,'prelive'), st = stats(ts), latest = ts.slice().sort((a,b)=>stamp(b)-stamp(a))[0];
    const dayTickets = latest ? ts.filter(b=>b.data===latest.data).sort((a,b)=>(a.ticket_slot||1)-(b.ticket_slot||1)) : [];
    return `<div class="sec-t">${viewLabel(view)}</div>
      <div class="card tipday">${dayTickets.length ? dayTickets.map(b=>`<div class="hd"><b>${ticketName(b)}${dayTickets.length>1?` · #${b.ticket_slot||dayTickets.indexOf(b)+1}`:''}</b><span class="free">${
        b.free_publication_confirmed ? tr('Partilhado no gratuito','Shared in the free channel') : tr('Publicado no Goal','Published in Goal')}</span></div>
        ${legs(b)}<div class="tiprow"><span>${esc(b.data)} · 1u · ${tr('Odd do bilhete','Ticket odds')} <b class="gold">${odds(b.odd)}</b></span>${badge(b.resultado)}</div>`).join('')
        : `<p class="scope-note">${tr('Ainda não há bilhetes publicados disponíveis.','No published tickets available yet.')}</p>`}
      <div class="ticket-summary"><span>${st.sinais} ${tr('bilhetes','tickets')} · ✅ ${st.ganhos} · ❌ ${st.perdidos}
      · <b class="${cls(st.lucro_u)}">${f2(st.lucro_u)}u</b></span>
      <button class="btn" data-filter="prelive">${tr('Ver histórico Pré-live','View Pre-live history')}</button></div>
      <p class="scope-note">${tr('Bilhetes confirmados do período indicado. Cada bilhete conta uma vez; a cópia no gratuito não é outra aposta. Jogos privados só aparecem após todas as pernas estarem resolvidas.','Confirmed tickets for the stated period. Each ticket counts once; the free-channel copy is not another bet. Private matches appear only after all legs settle.')}</p></div>`;
  }
  function productCards(rows, view) {
    return categories.map(key => { const st=stats(select(rows,key));
      return `<button class="est" data-filter="${key}"><div class="e-top"><span class="e-name">${key==='prelive'?viewLabel(view):labels[key]}</span>
        <span class="e-n">${st.sinais} ${key==='prelive'?tr('bilhetes','tickets'):tr('sinais','signals')}</span></div>
        <div class="bar"><div style="width:${st.wr}%"></div></div><div class="e-bot"><span>✅ ${st.ganhos} ❌ ${st.perdidos}
        · ${st.wr.toFixed(1)}%</span><strong class="${cls(st.lucro_u)}">${f2(st.lucro_u)}u</strong></div></button>`;
    }).join('');
  }
  function render() {
    const allRows=normalize(DATA,fallback), view=active==='prelive'?preliveView:'pdf';
    const scoped=scopePrelive(allRows,view), base=active==='elite'?selectManual(scoped,eliteMarket):select(scoped,active,true);
    const months=monthlyStats(base);
    if(period!=='all'&&!months.some(m=>m.month===period))period='all';
    const rows=monthRows(scoped,period),financial=monthRows(base,period),visible=active==='elite'?selectManual(rows,eliteMarket):select(rows,active);
    const today=tradingDay(), p=panel(financial,today), pre=active==='prelive';
    const title=active==='all'?tr('Ao vivo + Elite','Live + Elite'):pre?viewLabel(view):labels[active]+(active==='elite'&&eliteMarket!=='all'?' · '+manualLabels[eliteMarket]:'');
    const conditionals=(DATA.historico_condicionais || []).filter(s=>category(s) && (active==='all' || category(s)===active)).length;
    const partialPrelive = !Array.isArray(DATA.prelive_resultados?.historico) || DATA.prelive_resultados?.indisponivel;
    document.getElementById('brand').textContent='GOAL SHARP ELITE';
    document.getElementById('tag').textContent=DATA.marca?.tagline || 'Live Goal Intelligence';
    document.getElementById('upd').textContent=tr('Dados atualizados: ','Data updated: ')+(DATA.atualizado || '').replace('T',' ');
    document.getElementById('app').innerHTML=`<div class="segwrap"><div class="segs" aria-label="${tr('Filtrar produto','Filter product')}">
      ${['all',...categories].map(k=>`<button class="seg ${k===active?'on':''}" aria-pressed="${k===active}" data-filter="${k}">${labels[k]}</button>`).join('')}</div></div>
      <div class="scope-head"><h2>${title}</h2><p>${active==='all'
        ? tr('Totais de Live 2.ª parte, Late Goal e Elite/manual. Pré-live da versão atual à parte; métodos anteriores no arquivo Pré-live.',
             'Totals for Live 2nd half, Late Goal and Elite/manual. Current-version pre-live is separate; earlier methods are in the Pre-live archive.')
        : pre ? tr('Publicações confirmadas do período indicado. Cada bilhete conta uma vez. O histórico completo continua disponível abaixo.',
                   'Confirmed publications for the stated period. Each ticket counts once. Full history remains available below.')
        : active==='elite' ? tr('Entradas manuais, incluindo Late Goal enviado para o Elite.','Manual entries, including Late Goal sent to Elite.')
        : tr('Sinais automáticos do bot. Entradas manuais estão no Elite.','Automatic bot signals. Manual entries are under Elite.')}</p></div>
      ${pre?preliveScopeControls(allRows,view):''}
      ${active==='elite'?manualControls(scoped):''}
      <p class="period-heading">${tr('Período:','Period:')} ${period==='all'?tr('Histórico completo','Full history'):monthLabel(period)}</p>
      ${(partialPrelive||DATA.combinada?.indisponivel)&&(pre||active==='all')?`<p class="scope-note">${tr('Histórico Pré-live temporariamente indisponível ou incompleto.','Pre-live history temporarily unavailable or incomplete.')}</p>`:''}
      <div id="kpis">${kpisFor(p.geral).replace(pre?(pt?'Sinais':'Signals'):'__never__',tr('Bilhetes','Tickets'))}</div>
      <p class="scope-note accounting">${tr('Resultado teórico às odds registadas; não comprova apostas executadas.','Theoretical results at recorded odds; not proof of executed bets.')}
      ${tr('Odd média: média simples de todas as cotações válidas do conjunto selecionado, incluindo pendentes.','Average odds: simple mean of all valid prices in the selected cohort, including pending entries.')}
      ${conditionals ? `${conditionals} ${tr('condicionais sem preço confirmado fora destas contas.','conditionals without confirmed odds excluded from these accounts.')}` : ''}
      ${p.geral.sem_preco ? `${p.geral.sem_preco} ${tr('registos sem preço válido excluídos de P/L e acerto.','records without valid odds excluded from P/L and win rate.')}` : ''}</p>
      ${formCard(p)}${period==='all'?periodsFor(p).replaceAll(pre?(pt?'sinais':'signals'):'__never__',tr('bilhetes','tickets')):''}
      <p class="scope-note">${tr('Dia de atividade:','Activity day:')} ${today} · 06:00–06:00 Europe/Lisbon</p>
      <div class="sec-t" id="banca">${tr('Evolução em unidades','Cumulative units')} — ${title}</div>${monthControls(months)}${chart(equitySeries(financial))}${monthlyCards(months)}
      ${active==='all'||pre?ticketCard(rows,today,view):''}
      <div class="sec-t" id="estrat">${tr('Resultados por produto · todos os mercados','Results by product · all markets')}</div><div class="grid estrats">${productCards(rows,view)}</div>
      <div class="sec-t" id="hist">${tr('Histórico','History')} — ${active==='all'?tr('todos os produtos · Pré-live Versão atual','all products · Pre-live Current version'):title}</div>${history(visible)}
      <p class="scope-note">${tr('Os registos originais foram preservados. O Pré-live anterior a 06/11 está no arquivo separado e não entra nos totais da versão atual. O antigo arquivo de Golos continua fora desta vista.',
        'Original records are preserved. Pre-live before 06 Nov is in a separate archive and excluded from current-version totals. The old Goals archive remains outside this view.')}</p>`;
    document.querySelectorAll('[data-filter]').forEach(el=>el.addEventListener('click',()=>{
      active=el.dataset.filter;page=1;preliveView='pdf';eliteMarket='all';render();syncURL();
    }));
    document.querySelectorAll('[data-prelive-scope]').forEach(el=>el.addEventListener('click',()=>{
      preliveView=el.dataset.preliveScope;page=1;render();syncURL();
    }));
    document.querySelectorAll('[data-manual]').forEach(el=>el.addEventListener('click',()=>{
      eliteMarket=el.dataset.manual;page=1;render();syncURL();
    }));
    function changeMonth(value,focus=false){period=value;page=1;render();syncURL();document.getElementById('banca').scrollIntoView({block:'start'});if(focus)document.getElementById('chart-month').focus({preventScroll:true});}
    document.getElementById('chart-month').addEventListener('change',e=>changeMonth(e.target.value,true));
    document.querySelectorAll('[data-month]').forEach(el=>el.addEventListener('click',()=>changeMonth(el.dataset.month)));
    document.querySelectorAll('[data-page]').forEach(el=>el.addEventListener('click',()=>{
      page=+el.dataset.page;render();document.getElementById('hist').scrollIntoView({block:'start'});
    }));
    bindChart(document.querySelector('.chart-plot'),equitySeries(financial),{pt,stake:STAKE});
    document.querySelectorAll('.langswitch a').forEach(a=>{const url=new URL(a.href);url.searchParams.set('strat',active);
      if(active==='prelive'&&preliveView!=='pdf')url.searchParams.set('prelive_scope',preliveView);else url.searchParams.delete('prelive_scope');
      if(active==='elite'&&eliteMarket!=='all')url.searchParams.set('elite_market',eliteMarket);else url.searchParams.delete('elite_market');
      if(period!=='all')url.searchParams.set('month',period);else url.searchParams.delete('month');a.href=url.href;});
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
