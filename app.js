const $ = s => document.querySelector(s);
let all = [];

const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = v => `${n(v) >= 0 ? '+' : ''}${n(v).toFixed(2)} USDT`;
const pct = v => `${n(v) >= 0 ? '+' : ''}${n(v).toFixed(2)}%`;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const duration = s => {
  s = Math.max(0, n(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
};
const fmtMetric = v => (v === null || v === undefined || v === '') ? '—' : pct(v);
const validDate = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };
const localTime = ms => ms == null ? '—' : new Date(ms).toLocaleString([], {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});

function normalize(raw, i) {
  const closedMs = validDate(raw.closed_at);
  const dur = n(raw.duration_seconds ?? raw.duration_sec);
  const explicitOpen = validDate(raw.opened_at ?? raw.signal_at);
  const openedMs = explicitOpen ?? (closedMs != null && dur > 0 ? closedMs - dur * 1000 : closedMs);
  const net = n(raw.net_pnl ?? raw.pnl_usdt);
  const roi = n(raw.roi_percent ?? raw.roi_pct);
  const fees = n(raw.fees ?? raw.fees_usdt);
  const result = String(raw.result || (net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'BE')).toUpperCase();
  const timeframe = String(raw.timeframe ?? '').trim();
  return {
    ...raw,
    _key: String(raw.trade_id ?? raw.id ?? `${raw.channel || 'Unknown'}|${raw.symbol || ''}|${raw.closed_at || i}`),
    trade_id: raw.trade_id ?? raw.id ?? i + 1,
    symbol: String(raw.symbol || '').toUpperCase(),
    channel: String(raw.channel || 'Unknown'),
    mode: String(raw.mode || 'UNKNOWN').toUpperCase(),
    timeframe,
    timeframe_label: timeframe || 'No TF',
    opened_ms: openedMs,
    opened_approx: explicitOpen == null && openedMs != null,
    opened_at: raw.opened_at || raw.signal_at || (openedMs != null ? new Date(openedMs).toISOString() : null),
    closed_ms: closedMs,
    closed_at: raw.closed_at || null,
    duration_seconds: dur,
    entries_used: Math.max(1, n(raw.entries_used || (Array.isArray(raw.entry_legs) ? raw.entry_legs.length : 1))),
    net_pnl: net,
    roi_percent: roi,
    fees,
    result,
    reason: String(raw.reason ?? raw.exit_reason ?? ''),
    mfe_percent: raw.mfe_percent == null ? null : n(raw.mfe_percent),
    mae_percent: raw.mae_percent == null ? null : n(raw.mae_percent)
  };
}

function exitPolicy(x) {
  if (Array.isArray(x.split_exit_plan) && x.split_exit_plan.length) {
    return 'Split ' + x.split_exit_plan.map(p => `TP${p.target}:${p.percent}%`).join(' / ');
  }
  if (x.target_percent != null) return `Custom +${n(x.target_percent).toFixed(2)}%`;
  if (x.preferred_target != null) return n(x.preferred_target) === 99 ? 'Last target' : `Target ${x.preferred_target || 1}`;
  return '—';
}

function resultOf(x) { return String(x.result || '').toUpperCase(); }
function aggregate(a) {
  const wins = a.filter(x => resultOf(x) === 'WIN').length;
  const losses = a.filter(x => resultOf(x) === 'LOSS').length;
  const decided = wins + losses;
  const mfes = a.map(x => x.mfe_percent).filter(v => v !== null);
  const maes = a.map(x => x.mae_percent).filter(v => v !== null);
  return {
    n: a.length, wins, losses, be: a.length - decided,
    net: a.reduce((s,x) => s + x.net_pnl, 0),
    fees: a.reduce((s,x) => s + x.fees, 0),
    roi: a.length ? a.reduce((s,x) => s + x.roi_percent, 0) / a.length : 0,
    wr: decided ? wins / decided * 100 : 0,
    dur: a.length ? a.reduce((s,x) => s + x.duration_seconds, 0) / a.length : 0,
    mfe: mfes.length ? mfes.reduce((a,b) => a+b,0) / mfes.length : null,
    mae: maes.length ? maes.reduce((a,b) => a+b,0) / maes.length : null
  };
}

function baseFiltered() {
  const mode = $('#mode').value, sym = $('#symbol').value.trim().toUpperCase(), tf = $('#timeframe').value;
  return all.filter(x =>
    (mode === 'ALL' || x.mode === mode) &&
    (!sym || x.symbol.includes(sym)) &&
    (tf === 'ALL' || (tf === '__NO_TF__' ? !x.timeframe : x.timeframe === tf))
  );
}
function tradeFiltered() {
  const ch = $('#channel').value;
  return baseFiltered().filter(x => ch === 'ALL' || x.channel === ch);
}

function bars(el, rows) {
  const mx = Math.max(1, ...rows.map(x => Math.abs(x[1])));
  $(el).innerHTML = rows.map(([k,v]) => `<div class="bar-row"><span>${esc(k)}</span><div class="track"><div class="fill ${v<0?'loss':''}" style="width:${Math.max(2,Math.abs(v)/mx*100)}%"></div></div><b class="${v>=0?'positive':'negative'}">${money(v)}</b></div>`).join('') || '<div class="empty-note">No data</div>';
}
function cards(items) {
  return items.map(([k,v,cls='']) => `<div class="mini"><span>${esc(k)}</span><strong class="${cls}">${v}</strong></div>`).join('');
}

/*
  Convergence window is NOT a chart timeframe.
  It only means: how many minutes apart the same symbol was opened by different channels.
  Missing timeframe values are therefore fully supported.
*/
function convergenceClusters(source, minutes) {
  const windowMs = minutes * 60000;
  const bySymbol = {};
  source.filter(x => x.symbol && x.opened_ms != null).forEach(x => (bySymbol[x.symbol] ??= []).push(x));
  const out = [];
  for (const [symbol, rows] of Object.entries(bySymbol)) {
    rows.sort((a,b) => a.opened_ms - b.opened_ms);
    let i = 0;
    while (i < rows.length) {
      const start = rows[i].opened_ms;
      const candidates = [];
      let j = i;
      while (j < rows.length && rows[j].opened_ms - start <= windowMs) { candidates.push(rows[j]); j++; }

      // Keep the earliest occurrence from each channel inside this convergence event.
      const firstByChannel = new Map();
      for (const x of candidates) if (!firstByChannel.has(x.channel)) firstByChannel.set(x.channel, x);
      const unique = [...firstByChannel.values()].sort((a,b) => a.opened_ms - b.opened_ms);

      if (unique.length >= 2) {
        out.push({
          symbol,
          group: unique,
          channels: unique.map(x => x.channel),
          start,
          span: unique[unique.length - 1].opened_ms - start
        });
        // Start searching after the last trade included in this event to avoid duplicate events.
        i = j;
      } else i++;
    }
  }
  return out;
}

function render() {
  const a = tradeFiltered();
  const base = baseFiltered();
  const g = aggregate(a);
  const windowMin = n($('#window').value);
  const selectedChannel = $('#channel').value;
  let clusters = convergenceClusters(base, windowMin);
  if (selectedChannel !== 'ALL') clusters = clusters.filter(c => c.channels.includes(selectedChannel));

  const ks = [
    ['Closed trades', g.n, ''], ['Win rate', `${g.wr.toFixed(1)}%`, ''],
    ['Net P&L', money(g.net), g.net>0?'positive':g.net<0?'negative':'neutral'],
    ['Recorded fees', `${g.fees.toFixed(2)} USDT`, ''],
    ['Average ROI', pct(g.roi), g.roi>0?'positive':g.roi<0?'negative':'neutral'],
    ['Avg duration', duration(g.dur), '']
  ];
  $('#kpis').innerHTML = ks.map(x => `<div class="kpi"><div class="label">${x[0]}</div><div class="value ${x[2]}">${x[1]}</div></div>`).join('');

  const byChannel = {};
  a.forEach(x => (byChannel[x.channel] ??= []).push(x));
  $('#channels').innerHTML = Object.entries(byChannel)
    .map(([name,rows]) => [name,aggregate(rows)])
    .sort((x,y) => y[1].net - x[1].net)
    .map(([name,z]) => `<tr><td>${esc(name)}</td><td>${z.n}</td><td>${z.wr.toFixed(1)}%</td><td class="${z.net>=0?'positive':'negative'}">${money(z.net)}</td><td>${pct(z.roi)}</td><td>${fmtMetric(z.mfe)}</td><td>${fmtMetric(z.mae)}</td><td>${duration(z.dur)}</td></tr>`).join('') || '<tr><td colspan="8">No data</td></tr>';

  const mo = {}, dy = {};
  a.forEach(x => {
    const m = String(x.closed_at || '').slice(0,7) || 'Unknown';
    const d = String(x.closed_at || '').slice(0,10) || 'Unknown';
    mo[m] = (mo[m] || 0) + x.net_pnl;
    dy[d] = (dy[d] || 0) + x.net_pnl;
  });
  bars('#months', Object.entries(mo).sort());
  bars('#days', Object.entries(dy).sort().slice(-14));

  // Pattern Lab
  const involved = new Set(clusters.flatMap(c => c.group.map(x => x._key)));
  const multiTrades = base.filter(x => involved.has(x._key));
  const multiAgg = aggregate(multiTrades);
  const uniquePatternSymbols = new Set(clusters.map(c => c.symbol)).size;
  $('#patternHint').textContent = `same symbol within ${windowMin} minutes`;
  $('#patternSummary').innerHTML = cards([
    ['Convergence events', clusters.length],
    ['Unique symbols', uniquePatternSymbols],
    ['Trades involved', multiTrades.length],
    ['Multi-source win rate', `${multiAgg.wr.toFixed(1)}%`],
    ['Multi-source net', money(multiAgg.net), multiAgg.net>=0?'positive':'negative'],
    ['Max sources / event', clusters.length ? Math.max(...clusters.map(c=>c.channels.length)) : 0]
  ]);
  $('#patterns').innerHTML = clusters
    .sort((x,y) => y.start - x.start).slice(0,100)
    .map(c => {
      const q = aggregate(c.group);
      const seq = c.group.map((x,i) => {
        const delta = i ? ` (+${Math.round((x.opened_ms-c.start)/60000)}m)` : '';
        const approx = x.opened_approx ? ' <span class="approx">≈ derived</span>' : '';
        return `${i+1}. ${esc(x.channel)} <span class="muted">[${esc(x.timeframe_label)}]</span>${delta}${approx}`;
      }).join('<br>');
      return `<tr><td><b>${esc(c.symbol)}</b></td><td>${localTime(c.start)}</td><td>${c.channels.length}</td><td>${Math.round(c.span/60000)}m</td><td class="sequence">${seq}</td><td class="${q.net>=0?'positive':'negative'}">${money(q.net)} · ${q.wr.toFixed(0)}% WR</td></tr>`;
    }).join('') || `<tr><td colspan="6">No cross-channel convergence found in the selected ${windowMin}-minute window.</td></tr>`;

  // Lead / lag from convergence events only.
  const lead = {};
  clusters.forEach(c => {
    const ordered = c.group;
    const first = ordered[0];
    const z = lead[first.channel] ??= {first:0, followers:0, minutes:0, symbols:new Set()};
    z.first++;
    z.symbols.add(c.symbol);
    for (const follower of ordered.slice(1)) {
      z.followers++;
      z.minutes += (follower.opened_ms - first.opened_ms) / 60000;
    }
  });
  $('#leaders').innerHTML = Object.entries(lead).sort((a,b)=>b[1].first-a[1].first)
    .map(([ch,z]) => `<tr><td>${esc(ch)}</td><td>${z.first}</td><td>${z.followers}</td><td>${z.followers?(z.minutes/z.followers).toFixed(1)+'m':'—'}</td><td>${z.symbols.size}</td></tr>`).join('') || '<tr><td colspan="5">No lead/lag data yet.</td></tr>';

  const singleTrades = base.filter(x => !involved.has(x._key));
  const singleAgg = aggregate(singleTrades);
  $('#agreement').innerHTML = cards([
    ['Single-source trades', singleTrades.length],
    ['Single-source win rate', `${singleAgg.wr.toFixed(1)}%`],
    ['Single-source avg ROI', pct(singleAgg.roi)],
    ['Multi-source trades', multiTrades.length],
    ['Multi-source win rate', `${multiAgg.wr.toFixed(1)}%`],
    ['Multi-source avg ROI', pct(multiAgg.roi)]
  ]);

  // Opening hour and weekday analytics use the viewer's browser local time.
  const hourRows = Array.from({length:24}, (_,h) => [h, []]);
  const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayRows = Object.fromEntries(weekdays.map(d => [d, []]));
  a.filter(x=>x.opened_ms!=null).forEach(x => {
    const d = new Date(x.opened_ms);
    hourRows[d.getHours()][1].push(x);
    dayRows[weekdays[d.getDay()]].push(x);
  });
  bars('#hours', hourRows.filter(([,r])=>r.length).map(([h,r]) => [`${String(h).padStart(2,'0')}:00`, aggregate(r).net]));
  bars('#weekdays', weekdays.filter(d=>dayRows[d].length).map(d => [d, aggregate(dayRows[d]).net]));

  // Symbol performance
  const bySymbol = {};
  a.forEach(x => { const z = bySymbol[x.symbol] ??= {rows:[],sources:new Set()}; z.rows.push(x); z.sources.add(x.channel); });
  $('#symbols').innerHTML = Object.entries(bySymbol)
    .map(([sym,z]) => [sym,z,aggregate(z.rows)]).sort((x,y)=>y[2].net-x[2].net).slice(0,50)
    .map(([sym,z,q]) => `<tr><td><b>${esc(sym)}</b></td><td>${q.n}</td><td>${z.sources.size}</td><td>${q.wr.toFixed(1)}%</td><td class="${q.net>=0?'positive':'negative'}">${money(q.net)}</td><td>${pct(q.roi)}</td><td>${duration(q.dur)}</td></tr>`).join('') || '<tr><td colspan="7">No data</td></tr>';

  const dca = a.filter(x=>x.entries_used>1), single = a.filter(x=>x.entries_used<=1);
  const best = a.length ? [...a].sort((x,y)=>y.net_pnl-x.net_pnl)[0] : null;
  const worst = a.length ? [...a].sort((x,y)=>x.net_pnl-y.net_pnl)[0] : null;
  $('#profile').innerHTML = cards([
    ['Single-entry', `${single.length} trades`], ['DCA / multi-entry', `${dca.length} trades`],
    ['Average hold', duration(g.dur)], ['Longest hold', duration(Math.max(0,...a.map(x=>x.duration_seconds)))],
    ['Best trade', best ? `${esc(best.symbol)} · ${money(best.net_pnl)}` : '—'],
    ['Worst trade', worst ? `${esc(worst.symbol)} · ${money(worst.net_pnl)}` : '—']
  ]);

  // Duration buckets
  const buckets = [
    ['< 15m', x=>x.duration_seconds < 900],
    ['15–60m', x=>x.duration_seconds >= 900 && x.duration_seconds < 3600],
    ['1–4h', x=>x.duration_seconds >= 3600 && x.duration_seconds < 14400],
    ['4–12h', x=>x.duration_seconds >= 14400 && x.duration_seconds < 43200],
    ['12h+', x=>x.duration_seconds >= 43200]
  ];
  $('#durations').innerHTML = buckets.map(([label,test]) => [label,aggregate(a.filter(test))]).filter(([,q])=>q.n)
    .map(([label,q]) => `<tr><td>${label}</td><td>${q.n}</td><td>${q.wr.toFixed(1)}%</td><td class="${q.net>=0?'positive':'negative'}">${money(q.net)}</td><td>${pct(q.roi)}</td></tr>`).join('') || '<tr><td colspan="5">No data</td></tr>';

  // Exit reasons
  const reasons = {};
  a.forEach(x => (reasons[x.reason || 'Unknown'] ??= []).push(x));
  $('#reasons').innerHTML = Object.entries(reasons).map(([r,rows])=>[r,aggregate(rows)]).sort((x,y)=>y[1].n-x[1].n)
    .map(([r,q])=>`<tr><td>${esc(r)}</td><td>${q.n}</td><td>${q.wr.toFixed(1)}%</td><td class="${q.net>=0?'positive':'negative'}">${money(q.net)}</td></tr>`).join('') || '<tr><td colspan="4">No data</td></tr>';

  $('#count').textContent = `${a.length} rows`;
  $('#trades').innerHTML = [...a].sort((x,y)=>(y.closed_ms??0)-(x.closed_ms??0)).map(x => {
    const openApprox = x.opened_approx ? ' ≈' : '';
    return `<tr><td title="${x.opened_approx?'Derived from closed time minus duration':''}">${localTime(x.opened_ms)}${openApprox}</td><td>${localTime(x.closed_ms)}</td><td><span class="badge ${esc(x.mode.toLowerCase())}">${esc(x.mode)}</span></td><td>${esc(x.channel)}</td><td><b>${esc(x.symbol)}</b></td><td>${esc(x.timeframe_label)}</td><td>${x.entries_used}</td><td class="${x.result==='WIN'?'positive':x.result==='LOSS'?'negative':'neutral'}">${esc(x.result)}</td><td class="${x.net_pnl>=0?'positive':'negative'}">${money(x.net_pnl)}</td><td>${pct(x.roi_percent)}</td><td>${fmtMetric(x.mfe_percent)}</td><td>${fmtMetric(x.mae_percent)}</td><td>${x.fees.toFixed(4)}</td><td>${duration(x.duration_seconds)}</td><td title="${esc(exitPolicy(x))}">${esc(exitPolicy(x))}</td><td title="${esc(x.reason)}">${esc(x.reason.slice(0,38))}</td></tr>`;
  }).join('') || '<tr><td colspan="16">No trades match these filters.</td></tr>';
}

async function load() {
  try {
    const r = await fetch(`data/trades.json?t=${Date.now()}`, {cache:'no-store'});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const raw = Array.isArray(d.trades) ? d.trades : [];
    all = raw.map(normalize).filter(x => !x.status || String(x.status).toUpperCase() === 'CLOSED');
    $('#updated').textContent = `Updated ${d.updated_at || '—'}`;

    const channels = [...new Set(all.map(x=>x.channel).filter(Boolean))].sort();
    $('#channel').innerHTML = '<option value="ALL">All channels</option>' + channels.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');

    const tfs = [...new Set(all.map(x=>x.timeframe).filter(Boolean))].sort();
    const hasNoTf = all.some(x=>!x.timeframe);
    $('#timeframe').innerHTML = '<option value="ALL">All / no restriction</option>' + (hasNoTf?'<option value="__NO_TF__">No timeframe</option>':'') + tfs.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');
    render();
  } catch (e) {
    $('#updated').textContent = 'Ledger unavailable';
    console.error(e);
  }
}

['mode','channel','timeframe','window'].forEach(id => $('#'+id).addEventListener('change', render));
$('#symbol').addEventListener('input', render);
$('#refresh').addEventListener('click', load);
load();
