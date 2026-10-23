/* Video-time coaching engine. No offline alignment verdicts or future observations. */
(function (root) {
  "use strict";
  const VERSION = "stage-1.0";
  const MONITOR_BUILD = "F10";
  const FAST_WINDOW = 8;
  const FAST_PROFILES = {
    standard:{high:340,low:150,pause:3.5,volume:.65,pitch:1.8},
    active:{high:320,low:160,pause:2.5,volume:.75,pitch:2.2}
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const finite = x => typeof x === "number" && Number.isFinite(x);
  const mean = xs => { const values = xs.filter(finite); return values.length ? values.reduce((a,b) => a+b,0)/values.length : null; };
  const clean = x => String(x || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const gram = text => { const s = clean(text); return new Set(s.length < 2 ? [s].filter(Boolean) : Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2))); };
  const overlap = (a,b) => { const tokens = gram(a); return tokens.size ? [...tokens].filter(t => b.has(t)).length/tokens.size : 0; };
  const hash = text => { let h=2166136261; for(const c of String(text)) { h ^= c.charCodeAt(0); h=Math.imul(h,16777619); } return (h>>>0).toString(16); };
  const clock = seconds => { const n=Math.max(0,Math.floor(seconds)); return `${String(Math.floor(n/60)).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`; };
  function duration(data) {
    return Math.max(1, Number(data.expression_map?.duration || 0), Number(data.visual_observations?.duration_seconds || 0),
      ...(data.expression_map?.units || []).map(u=>Number(u.time_span?.[1] || 0)));
  }
  function sourceKey(data) { return hash(JSON.stringify([data.case_id,data.video_url,duration(data),(data.expression_map?.units || []).map(u=>[u.time_span,u.text])])); }
  function intentKey(data,plan=null) { return hash(JSON.stringify(plan ? plan.map(b=>[b.id,b.claims,b.title]) : (data.intent_map?.beats || []).map(b=>[b.beat_id,b.required_claims,b.target_meaning]))); }
  function defaultPlan(data, limit=duration(data)) {
    const beats=data.intent_map?.beats || [];
    return beats.map((b,i)=>({id:b.beat_id, title:b.target_meaning, claims:(b.required_claims?.length ? b.required_claims : [b.target_meaning]).filter(Boolean),
      priority:Number(b.importance || 0)>=.8 ? 3 : 2, must:true, deadline:Math.round(limit*(i+1)/(beats.length+1)),
      estimate:clamp(Math.ceil(clean(b.target_meaning).length/4),8,45)}));
  }
  function availableUnits(data, t) {
    return (data.expression_map?.units || []).filter(u=>finite(u.time_span?.[0]) && finite(u.time_span?.[1]) && u.time_span[1]<=t && u.time_span[1]>u.time_span[0])
      .sort((a,b)=>a.time_span[1]-b.time_span[1]);
  }
  function textWindows(units) {
    const result=[];
    for(let i=0;i<units.length;i++) {
      if(Number(units[i].reliability?.text || 0)<.6) continue;
      let text="";
      for(let j=i;j>=0 && j>=i-15;j--) {
        if(units[i].time_span[1]-units[j].time_span[0]>60 || Number(units[j].reliability?.text || 0)<.6) break;
        text=units[j].text+" "+text;
        // Include individual sentences and short spans. An unrelated earlier
        // negation must not invalidate a later, complete positive statement.
        const previous=j>0 ? String(units[j-1].text).trim() : "";
        const boundaryNegative=/^(?:不|不能|没有|not|never|do not)$/i.test(previous) ? previous+" " : "";
        result.push({text:boundaryNegative+text,tokens:gram(text),start:units[j].time_span[0],end:units[i].time_span[1]});
      }
    }
    return result;
  }
  function guardMeaning(claim, text) {
    const numbers=String(claim).match(/\d+(?:\.\d+)?/g) || [];
    if(numbers.some(n=>!(String(text).match(/\d+(?:\.\d+)?/g) || []).includes(n))) return "关键数字待核对";
    const negative=/(?:不(?:能|可以|会|应|是|要|需要|支持|具有|具备|适合|接受|建议|存在|允许|代表|同意|必)|没(?:有|能)|无(?:需|法)|并非|未(?:能|必)|\bnot\b|\bnever\b|\bcannot\b|\bcan't\b|\bdon't\b)/i;
    if(negative.test(claim)!==negative.test(text)) return "否定关系待核对";
    return "";
  }
  function assess(plan, units, manual, t) {
    const windows=textWindows(units);
    return plan.map(b=>{
      const claims=b.claims.map(text=>{
        const tokens=[...gram(text)];
        let firstMatchedAt=null;
        let best={score:0,text:"",start:0,end:0,guard:"",matched:false};
        for(const w of windows) {
          const score=tokens.length ? tokens.filter(token=>w.tokens.has(token)).length/tokens.length : 0,guard=score>=.72 ? guardMeaning(text,w.text) : "",matched=score>=.78 && !guard;
          if(matched && (firstMatchedAt===null || w.end<firstMatchedAt)) firstMatchedAt=w.end;
          if((matched && !best.matched) || (matched===best.matched && (score>best.score || (score===best.score && w.text.length<best.text.length)))) best={...w,score,guard,matched};
        }
        const guard=best.guard;
        return {text,score:best.score,matched:best.score>=.78 && !guard,firstMatchedAt,guard,evidence:best.text,start:best.start,end:best.end};
      });
      const edits=manual.filter(e=>e.beatId===b.id && e.at<=t).sort((a,b)=>a.at-b.at);
      const confirmed=edits.length ? edits[edits.length-1].value : null;
      const matched=claims.filter(c=>c.matched).length;
      return {...b,claims,score:mean(claims.map(c=>c.score)) || 0,matched,total:claims.length,
        status:confirmed===true ? "confirmed" : confirmed===false ? "pending" : claims.length && matched===claims.length ? "matched" : claims.some(c=>c.score>=.3) ? "partial" : "pending",
        completedAt:confirmed===true ? edits.at(-1).at : confirmed===false || matched!==claims.length ? null : Math.max(0,...claims.map(c=>c.firstMatchedAt)),
        manual:confirmed!==null};
    });
  }
  const complete = b => ["confirmed","matched","semantic"].includes(b.status);
  function mergeSemantic(beats,semantic,t) {
    if(!semantic || !finite(semantic.as_of) || semantic.as_of>t) return beats;
    return beats.map(b=>{
      const result=semantic.beats?.find(x=>x.id===b.id);
      if(!result || !Array.isArray(result.facets))return b;
      const facets=result.facets;
      if(facets.some(f=>(f.state==="supported" && !f.evidence) || (f.evidence && (!finite(f.evidence.end) || f.evidence.end>semantic.as_of || f.evidence.end>t))))return b;
      const supported=facets.filter(f=>f.state==="supported").length, conflicts=facets.filter(f=>f.state==="conflict"),related=facets.filter(f=>f.state==="related").length;
      const enriched={...b,semantic:{facets,supported,related,conflicts:conflicts.length,at:semantic.as_of},uncertain:facets.length-supported};
      if(b.manual)return enriched;
      if(conflicts.length)return {...enriched,status:"conflict",completedAt:null};
      if(facets.length && supported===facets.length)return {...enriched,status:"semantic",completedAt:Math.max(...facets.map(f=>finite(f.first_supported_at) && f.first_supported_at>=0 && f.first_supported_at<=f.evidence.end ? f.first_supported_at : f.evidence.end))};
      if(facets.length)return {...enriched,status:supported || related ? "partial" : "pending",completedAt:null};
      return enriched;
    });
  }
  function metrics(units,t,window=30) {
    const local=units.filter(u=>u.time_span[1]>Math.max(0,t-window));
    const audio=local.filter(u=>Number(u.reliability?.audio || 0)>=.6);
    const reliable=audio.filter(u=>finite(u.speech?.pace_per_minute) && u.speech.pace_per_minute>0);
    const seconds=reliable.reduce((sum,u)=>sum+u.time_span[1]-u.time_span[0],0);
    const pace=seconds>=3 ? reliable.reduce((sum,u)=>sum+u.speech.pace_per_minute*(u.time_span[1]-u.time_span[0]),0)/seconds : null;
    const rms=mean(audio.map(u=>u.speech?.rms_energy));
    const pitch=mean(audio.map(u=>u.speech?.pitch_range_semitones));
    // Leading silence and gaps between missing annotations are not treated as a measured pause.
    const pauses=audio.filter(u=>u.time_span[0]>0 && Number(u.speech?.pause_before)>=.8 && Number(u.speech.pause_before)<20);
    return {pace,rms,pitch,pauseMean:mean(pauses.map(u=>u.speech.pause_before)),sampleCount:audio.length,paceSampleCount:reliable.length,latestPace:reliable.at(-1) || null,seconds,
      latest:audio.at(-1) || null, maxPause:Math.max(0,...pauses.map(u=>u.speech.pause_before))};
  }
  function histories(rows,speaker) {
    const unique=new Map();
    rows.filter(r=>r.version===VERSION && r.speakerId===speaker && r.sourceType==="video_replay" && r.eligible && !r.example)
      .sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).forEach(r=>unique.set(r.sourceKey,r));
    return [...unique.values()];
  }
  function recentMetrics(units,t,window=FAST_WINDOW) {
    const recent=units.filter(u=>u.time_span[1]<=t && u.time_span[1]>Math.max(0,t-window));
    const clipped=recent.map(u=>({...u,time_span:[Math.max(0,t-window,u.time_span[0]),u.time_span[1]]}));
    const m=metrics(clipped,t,window), audio=clipped.filter(u=>Number(u.reliability?.audio || 0)>=.6);
    const weighted=key=>{const valid=audio.filter(u=>finite(u.speech?.[key]) && u.speech[key]>0),seconds=valid.reduce((n,u)=>n+u.time_span[1]-u.time_span[0],0);return seconds?valid.reduce((n,u)=>n+u.speech[key]*(u.time_span[1]-u.time_span[0]),0)/seconds:null;};
    return {...m,window,rms:weighted("rms_energy"),pitch:weighted("pitch_range_semitones"),latest:recent.filter(u=>Number(u.reliability?.audio || 0)>=.6).at(-1) || null};
  }
  function baseline(rows,speaker,data,progress,planKey,contentKey=intentKey(data),assessmentMethod="lexical-1.0") {
    // Exclude this recording: replaying identical audio is not an independent practice sample.
    const history=histories(rows,speaker).filter(r=>r.sourceKey!==sourceKey(data) && r.language===(data.intent_map?.language || "zh"));
    const atPhase=history.map(r=>{
      const candidates=(r.snapshots || []).filter(s=>Math.abs(s.progress-progress)<=.075);
      return candidates.sort((a,b)=>Math.abs(a.progress-progress)-Math.abs(b.progress-progress))[0];
    }).filter(Boolean);
    const sameIntent=history.filter(r=>r.intentKey===contentKey && (r.assessmentMethod || "lexical-1.0")===assessmentMethod);
    const comparable=sameIntent.filter(r=>r.planKey===planKey);
    const coverage=comparable.map(r=>(r.snapshots || []).filter(s=>Math.abs(s.progress-progress)<=.075).sort((a,b)=>Math.abs(a.progress-progress)-Math.abs(b.progress-progress))[0]?.coverage).filter(finite);
    return {assessmentMethod,count:atPhase.length,total:history.length,coverageCount:coverage.length,paceCount:atPhase.filter(s=>finite(s.pace)).length,pitchCount:atPhase.filter(s=>finite(s.pitch)).length,pace:mean(atPhase.map(s=>s.pace)),pitch:mean(atPhase.map(s=>s.pitch)),
      coverage:mean(coverage), recurring:id=>sameIntent.filter(r=>r.beats?.some(b=>b.id===id && (!b.complete || b.onTime===false))).length};
  }
  function planKey(plan,limit) { return hash(JSON.stringify([limit,plan.map(b=>[b.id,b.deadline,b.must,b.priority,b.estimate])])); }
  function paceState(m,t,profile="active") {
    const rules=FAST_PROFILES[profile] || FAST_PROFILES.active,end=m.latestPace?.time_span?.[1];
    const ready=finite(end) && t-end>=0 && t-end<=4 && m.paceSampleCount>=2 && m.seconds>=3 && finite(m.pace) && m.pace>0;
    // Classify the same whole-character rate shown to the speaker.
    const pace=ready?Math.round(m.pace):null;
    const kind=!ready?"waiting":pace>rules.high?"fast":pace<rules.low?"slow":"steady";
    return {kind,title:({waiting:"等待语音",fast:"语速偏快",slow:"语速偏慢",steady:"保持节奏"})[kind],pace,low:rules.low,high:rules.high};
  }
  function fastCue(m,baseline,units,t,remaining,beats=[],reserve=20,limit=Infinity,profile="active") {
    const rules=FAST_PROFILES[profile] || FAST_PROFILES.active,window=m.window || FAST_WINDOW;
    const prior=metrics(units.filter(u=>u.time_span[1]<=t-window),Math.max(0,t-window),Infinity);
    const pace=paceState(m,t,profile),fresh=pace.kind!=="waiting";
    const retainCodes=[];
    if(fresh && finite(m.pace) && m.seconds>=3) {
      if(pace.kind==="fast")retainCodes.push("pace");
      if(pace.kind==="slow")retainCodes.push("slow");
      if(finite(m.rms) && prior.rms>0 && m.rms<prior.rms*Math.min(.95,rules.volume+.1))retainCodes.push("volume");
      if(m.pitch>0 && m.pitch<rules.pitch+.4)retainCodes.push("pitch");
    }
    const wrap=(cue,alternatives=[])=>({...cue,alternatives,retainCodes,observedAt:m.latest?.time_span[1] ?? t});
    if(remaining<=0) return wrap({code:"deadline",title:"时间到了",reason:"本场设定的截止时间已到，请用一句话结束。",severity:3,priority:100});
    if(remaining<=reserve) return wrap({code:"closing",title:"准备收尾",reason:`还剩 ${Math.max(1,Math.ceil(remaining))} 秒，已进入预留收尾时间。用一句话回扣主题。`,severity:3,priority:95});
    if(remaining<=Math.min(60,limit*.2)) return wrap({code:"time",title:"抓紧收尾",reason:`还剩 ${Math.ceil(remaining)} 秒。${beats.some(b=>!complete(b))?"仍有重点待确认，优先说结论，减少展开。":"重点已有支持或确认，用剩余时间回扣主题。"}`,severity:2,priority:90});
    // Only echo a conflict tied to newly observed speech. Old unresolved items stay in the slow channel.
    const recent=beats.filter(b=>!b.manual && b.semantic && t-b.semantic.at>=0 && t-b.semantic.at<=10)
      .flatMap(b=>b.semantic.facets.filter(f=>f.state==="conflict" && f.evidence && t-f.evidence.end>=0 && t-f.evidence.end<=12).map(f=>({beat:b,facet:f})))
      .sort((a,b)=>b.facet.evidence.end-a.facet.evidence.end)[0];
    if(recent) {const issues=recent.facet.issues || [],numeric=issues.some(x=>x.includes("数字"));return {...wrap({code:"fact",beatId:recent.beat.id,title:numeric?"核对数字":"核对表述",reason:`刚才讲到「${shortMeaning(goalLabel(recent.beat.title),18)}」，${issues.join("；") || '关键含义待核对'}。核对「${shortMeaning(recent.facet.claim,35)}」后再展开。`,severity:2,priority:80}),observedAt:recent.facet.evidence.end};}
    if(!fresh || m.sampleCount<2 || !finite(m.pace)) return wrap({code:"waiting",title:"等待语音",reason:`等待最近 ${window} 秒内已结束且可靠的语音片段，暂不判断当前表达。`,severity:0,priority:0});
    const candidates=[];
    if(pace.kind==="fast") {
      candidates.push({code:"pace",title:"语速偏快",reason:`近 ${window} 秒 ${pace.pace} 字/分，高于本场参考上限 ${rules.high}。下一句放慢一点，句末留出停顿。`,severity:2,priority:60});
    }
    if(Number(m.latest.speech?.pause_before)>=rules.pause && Number(m.latest.speech.pause_before)<=15 && units.length>2)
      candidates.push({code:"pause",title:"接上下一句",reason:`刚结束语句的句前停顿 ${Number(m.latest.speech.pause_before).toFixed(1)} 秒，超过当前 ${rules.pause} 秒参考。想好下一句后继续。`,severity:2,priority:65});
    if(pace.kind==="slow")
      candidates.push({code:"slow",title:"语速偏慢",reason:`近 ${window} 秒 ${pace.pace} 字/分，低于本场参考下限 ${rules.low}。若不是刻意强调，下一句适当提速、连贯说完。`,severity:2,priority:60});
    if(prior.sampleCount>=5 && finite(prior.rms) && prior.rms>0 && m.sampleCount>=3 && m.seconds>=3 && finite(m.rms) && m.rms<prior.rms*rules.volume)
      candidates.push({code:"volume",title:"声音提一点",reason:`近 ${window} 秒响度约为本场此前的 ${Math.round(m.rms/prior.rms*100)}%，低于当前 ${Math.round(rules.volume*100)}% 参考。保持气息，把句尾说清。`,severity:1,priority:35});
    if(m.seconds>=6 && m.sampleCount>=3 && m.pitch>0 && m.pitch<rules.pitch)
      candidates.push({code:"pitch",title:"突出关键词",reason:`近 ${window} 秒音高起伏约 ${m.pitch.toFixed(1)} 半音，低于当前 ${rules.pitch} 参考。下一句可以把关键词说得更有轻重。`,severity:1,priority:25});
    candidates.sort((a,b)=>b.priority-a.priority);
    if(candidates.length)return wrap(candidates[0],candidates.slice(1));
    return wrap({code:"steady",title:"保持节奏",reason:`近 ${window} 秒 ${pace.pace} 字/分，在本场参考范围 ${rules.low}–${rules.high} 内。保持当前节奏，按意思自然停顿。`,severity:0,priority:0});
  }
  // Content is checked over a longer window than pace. Failure to match is
  // uncertainty, never proof of being off topic; introductions get time to develop.
  function contentCue(beats,units,t,slow) {
    const recent=units.filter(u=>u.time_span[1]<=t && u.time_span[1]>t-30 && Number(u.reliability?.text || 0)>=.6);
    const last=recent.at(-1),next=slow.queue.find(b=>b.allocatedSeconds>0),label=b=>shortMeaning(goalLabel(b?.title),16);
    const base={code:"content-waiting",kind:"waiting",title:"先听完整一句",status:"内容待观察",reason:"等一句可靠的完整表达，再看与重点的联系。",severity:0,priority:0,observedAt:last?.time_span[1] ?? t,beatId:null,window:30};
    if(!last || t-last.time_span[1]>6 || clean(recent.map(u=>u.text).join('')).length<8)return base;
    if(!beats.length)return {...base,kind:"no-outline",status:"尚未设置重点",reason:"先设置想讲清的重点，再判断内容是否贴合；声音监测照常进行。"};
    const localUnits=recent.filter(u=>u.time_span[1]>t-20);
    const fresh=end=>finite(end) && end<=t && t-end<=12 && last.time_span[1]-end<=8;
    const windows=textWindows(localUnits).filter(w=>fresh(w.end));
    const candidates=[];
    for(const b of beats) {
      const facets=b.semantic?.facets.filter(f=>f.evidence && fresh(f.evidence.end) && ['supported','related','conflict'].includes(f.state)) || [];
      const facet=facets.sort((a,b)=>b.evidence.end-a.evidence.end)[0];
      const claim=b.claims.map(c=>windows.map(w=>{const score=overlap(c.text,w.tokens),guard=score>=.72?guardMeaning(c.text,w.text):'';return {end:w.end,length:w.text.length,score,guard,matched:score>=.78 && !guard};})
        .sort((a,b)=>Number(b.matched)-Number(a.matched) || b.score-a.score || a.length-b.length || b.end-a.end)[0])
        .filter(c=>c?.score>=.55).sort((a,b)=>b.end-a.end || b.score-a.score)[0];
      // Cumulative caches may retain an older best excerpt. Fresh lexical
      // correspondence can still show relevance, but cannot add semantic support.
      if(!facet && !claim)continue;
      candidates.push({beat:b,facet,claim,at:facet?.evidence.end ?? claim.end,strength:facet?({supported:3,conflict:2,related:1})[facet.state]:claim.score});
    }
    candidates.sort((a,b)=>b.at-a.at || b.strength-a.strength);
    const focus=candidates[0];
    const duration=recent.reduce((n,u)=>n+Math.max(0,u.time_span[1]-Math.max(t-30,u.time_span[0])),0);
    // At least three substantially repeated utterances, spanning 12 seconds.
    // A deliberate second emphasis alone must not trigger a repetition warning.
    const text=clean(last.text),duplicates=text.length>=10?recent.filter(u=>clean(u.text).length>=10 && Math.min(overlap(last.text,gram(u.text)),overlap(u.text,gram(last.text)))>=.82):[];
    const repeating=duplicates.length>=3 && duplicates.at(-1).time_span[1]-duplicates[0].time_span[1]>=12;
    if(focus) {
      const b=focus.beat,target=label(b),quote=`「${target}」`;
      const common={...base,beatId:b.id,target,status:`相关 · ${target}`,observedAt:focus.at,sticky:true,basis:focus.facet?'语义证据':'文字对应'};
      const conflict=focus.facet?.state==='conflict' || (!focus.facet && focus.claim?.guard);
      if(conflict)return {...common,code:'content-check',kind:'check',title:'核对关键表述',status:`待核对 · ${target}`,reason:`刚才已讲到${quote}，${focus.facet?.issues?.join('；') || focus.claim?.guard || '关键含义仍需核对'}。确认这一句后再展开。`,severity:2,priority:80};
      const firstTimes=b.semantic?b.semantic.facets.filter(f=>f.state==='supported').map(f=>f.first_supported_at):b.claims.filter(c=>c.matched).map(c=>c.firstMatchedAt);
      const advancing=firstTimes.some(at=>finite(at) && at<=t && t-at<=20);
      const missing=b.semantic?.facets.find(f=>f.state!=='supported')?.claim || b.claims.find(c=>!c.matched)?.text;
      if(repeating && !advancing)return {...common,code:'content-repeat',kind:'repeat',title:'收束这一点',status:`近期表达重复 · ${target}`,reason:`近 30 秒已有三句高度相似的表达。用一句话收住${quote}${next && next.id!==b.id?`，再转向「${label(next)}」`:'，再补一个新信息或例证'}。`,severity:1,priority:55};
      if(complete(b))return {...common,code:'content-covered',kind:'covered',title:next?'转入下一点':'重点已齐',status:`本点已覆盖 · ${target}`,reason:`${quote}${b.status==='confirmed'?'已由你确认讲清':b.semantic?'必要含义已有支持':'预设文字已有对应'}。${next?`收住这一句，接着讲「${label(next)}」。`:'保持连贯，用一句话回扣主题。'}`,priority:10};
      if(!advancing && duration>=18 && recent.length>=4 && missing)return {...common,code:'content-complete',kind:'complete',title:'补清关键一句',status:`相关，待补清 · ${target}`,reason:`仍在展开${quote}。可补清「${shortMeaning(missing,34)}」；这是尚未核实的含义，如已说清可在下方确认。`,severity:1,priority:55};
      return {...common,code:'content-progress',kind:advancing?'progress':'linked',title:advancing?'贴题推进':'继续展开',status:`${advancing?'新增含义':'内容相关'} · ${target}`,reason:`刚才的内容对应${quote}。${advancing?'已有新的含义得到支持，保持连贯。':'继续把这一点说完整。'}${missing?`接着说明「${shortMeaning(missing,32)}」。`:''}`,priority:10};
    }
    const known=beats.some(b=>b.claims.some(c=>c.matched) || b.semantic?.supported>0);
    const sustained=t>=45 && duration>=18 && recent.length>=4 && [0,1,2].every(i=>recent.some(u=>u.time_span[1]>t-30+i*10 && u.time_span[1]<=t-20+i*10));
    // A recent semantic connection or a recognisable outline phrase protects
    // examples/transitions from a premature "return to topic" interruption.
    const context=gram(recent.map(u=>u.text).join(' '));
    const related=beats.find(b=>b.semantic?.facets.some(f=>f.evidence?.end>t-30 && f.evidence.end<=t && ['supported','related'].includes(f.state)) || [b.title,b.brief].some(s=>gram(s).size>=3 && overlap(s,context)>=.4));
    if(sustained && !related)return {...base,code:'content-bridge',kind:'bridge',title:known?'回扣主题':'点明主旨',status:'与重点的联系待说明',beatId:next?.id || null,reason:`近 30 秒的可靠表达尚未找到与预设重点的明确联系。${next?`可用一句话接回「${label(next)}」；`:'可用一句话点明本段与主题的关系；'}若在举例，先说明例子要证明什么。`,severity:1,priority:55,sticky:true};
    return {...base,code:'content-context',kind:'context',title:related?'说明关联':'继续铺垫',status:related?`相关背景 · ${label(related)}`:'铺垫或转场，继续观察',reason:related?`正在展开与「${label(related)}」相关的背景。下一句点明它要说明什么。`:`这段与重点的联系还需继续听。${next?`铺垫后点明「${label(next)}」。`:'接着说出本段的核心意思。'}`,priority:5,sticky:true,beatId:related?.id || next?.id || null};
  }
  function combineFastCue(audio,content) {
    const enriched={...audio,content};
    if(audio.priority>=80)return enriched;
    const paceWarning=['pace','slow'].includes(audio.code),linked=['progress','linked','covered'].includes(content.kind);
    if(paceWarning) {
      const title=content.severity>0?content.title:linked?(audio.code==='pace'?'贴题，稍放慢':'贴题，连贯讲'):audio.title;
      return {...enriched,title,reason:content.kind==='waiting'?audio.reason:`${content.reason} ${audio.reason}`,actionKey:`${audio.code}:${content.code}:${content.beatId || ''}`,priority:Math.max(audio.priority,content.priority)};
    }
    if(content.priority>audio.priority || ['waiting','steady'].includes(audio.code) && content.kind!=='waiting')return {...content,content,retainCodes:audio.retainCodes,alternatives:audio.code==='steady'?[audio]:audio.alternatives,
      reason:content.reason+(audio.code==='steady'?` 近 8 秒 ${audio.reason.match(/\d+ 字\/分/)?.[0] || ''}，语速适中。`:''),actionKey:`${content.code}:${content.kind}:${content.beatId || ''}`};
    return enriched;
  }
  function schedule(beats,t,limit,baseline) {
    const remaining=limit-t, reserve=Math.min(20,limit*.08), budget=Math.max(0,Math.floor(remaining-reserve));
    const ranked=beats.filter(b=>!complete(b)).map(b=>{
      const slack=b.deadline-t-b.estimate, misses=baseline.recurring(b.id);
      const urgency=slack<=0 ? 4 : slack<30 ? 3 : slack<90 ? 2 : 0;
      return {...b,slack,misses,urgent:slack<=30,rank:(b.must?100:0)+b.priority*12+urgency*15+Math.min(misses,3)*8+(b.status==="partial"?5:0)+(b.status==="conflict"?18:0)};
    }).sort((a,b)=>b.rank-a.rank || a.deadline-b.deadline);
    let left=budget;
    const queue=ranked.map(b=>{
      const minimum=Math.min(b.estimate,Math.max(3,Math.ceil(b.estimate*.25)));
      const allocatedSeconds=left>=b.estimate ? b.estimate : left>=minimum ? left : 0;
      left-=allocatedSeconds;
      const fits=allocatedSeconds===b.estimate;
      return {...b,allocatedSeconds,action:fits ? "补讲" : allocatedSeconds>0 ? "压缩" : "复盘",fits};
    });
    const next=queue[0], actionable=queue.find(b=>b.allocatedSeconds>0), due=queue.some(b=>b.urgent), allCost=queue.reduce((n,b)=>n+b.estimate,0);
    let title="按计划推进",reason="重点按预设截止点推进，尚未到需要补讲的时机。";
    if(remaining<=0) { title="结束表达，转入复盘"; reason=`还有 ${queue.length} 个重点未达到完整匹配，留到下一次练习。`; }
    else if(!queue.length) { title="重点已覆盖，准备收束"; reason="所有必需表述均已有匹配证据或人工确认，可用一句话回扣主题。"; }
    else if(!queue.some(b=>b.allocatedSeconds>0)) { title="立即收束，回扣主题"; reason=`剩余 ${clock(remaining)}，已不足以补清任何一个重点。用一句话结束，其余 ${queue.length} 项留到复盘。`; }
    else if(budget<allCost) { title=`先保留 ${actionable.id}，压缩展开`; reason=`剩余 ${clock(remaining)}，预留收尾 ${Math.round(reserve)} 秒；待讲约 ${Math.round(allCost)} 秒，${actionable.id} 分配 ${actionable.allocatedSeconds} 秒，来不及的内容留到复盘。`; }
    else if(due) { title=next.status==="conflict" ? `先核对 ${next.id} 的关键事实` : next.status==="partial" && !next.manual ? `先核对 ${next.id}，必要时补清` : `优先补清 ${next.id}`; reason=`${next.status==="conflict" ? "相关表达中的数字、否定或方向存在待核对项。" : next.status==="partial" && !next.manual ? "已有相关表达，自动匹配尚不能确认完整。" : ""}${next.deadline>=t ? `距该点截止 ${Math.round(next.deadline-t)} 秒` : `该点已过截止 ${Math.round(t-next.deadline)} 秒`}，补讲预算 ${next.estimate} 秒。${next.misses ? `历史同大纲中有 ${next.misses} 次未按时确认完整覆盖。` : "如已讲清可人工确认；如确有缺失，先补结论。"}`; }
    else if(next?.misses>=2) { title=`提前留意 ${next.id}`; reason=`历史同大纲有 ${next.misses} 次未按时完整覆盖，本场优先预留 ${next.estimate} 秒。`; }
    return {title,reason,queue,remaining,reserve,budget,allCost,needsReminder:remaining<=0 || (!queue.length && remaining<reserve) || due || budget<allCost,
      terminal:remaining<=reserve,key:remaining<=0 ? "end" : !queue.length || budget===0 ? "close" : `${next.id}:${budget<allCost ? "compress" : "due"}`};
  }
  function shortMeaning(text,max=28) {
    const value=String(text || "").replace(/\s+/g," ").trim();
    return Array.from(value).length>max?Array.from(value).slice(0,max).join("")+"…":value;
  }
  function goalLabel(text) {
    const value=String(text || "").replace(/\s+/g," ").trim();
    if(!/[\u4e00-\u9fff]/.test(value))return shortMeaning(value);
    const clauses=value.split(/[，。；]/).map(s=>s.trim()).filter(Boolean);
    // Quote an existing conclusion clause; keep the complete goal in the evidence panel.
    const clause=clauses.filter(s=>/^(最终|因此|所以|这使得|由此|这需要)/.test(s)).at(-1) || clauses[0] || value;
    const chars=clause.replace(/^我们现在就是要/,"").match(/[A-Za-z0-9][A-Za-z0-9*.+%\-]*|./gu) || [];
    return chars.length>32?chars.slice(0,16).join("")+"…"+chars.slice(-15).join(""):chars.join("");
  }
  function contentReview(beats,units,t,slow) {
    const raw=contentReviewEvidence(beats,units,t,slow);
    const focus=beats.find(b=>b.id===raw.focusId), target=focus || slow.queue.find(b=>b.allocatedSeconds>0) || slow.queue[0],allCovered=beats.length>0 && beats.every(complete);
    const label=b=>shortMeaning(goalLabel(b?.title),18), quote=text=>`「${shortMeaning(text,42)}」`;
    const goal=target?.brief || target?.claims.map(c=>c.text || c).join('；') || (allCovered?'用一句话回扣本场主题。':'');
    const first=goal.split(/[，。；]/).map(x=>x.trim()).find(Boolean) || '';
    // Existing outline summaries are planned goals, not evidence of what was said.
    const headline=target?.brief && Array.from(first).length<=20 && !/^(用|把|将|通过|对于|关于)/.test(first) ? first : label(target);
    const recent=units.filter(u=>u.time_span[1]<=t && u.time_span[1]>Math.max(0,t-30) && Number(u.reliability?.text || 0)>=.6);
    const fresh=recent.at(-1) && t-recent.at(-1).time_span[1]<=12;
    const excerpt=raw.excerpt || (fresh?shortMeaning(recent.slice(-2).map(u=>u.text).join(' '),90):'');
    const labels={confirmed:'人工已确认',supported:'本点已有支持',partial:'部分对齐',conflict:'表述待核对',unmatched:'尚未对齐',waiting:'等待本段表达'};
    const statuses=beats.map(b=>({id:b.id,title:label(b),state:b.status,status:b.status==='confirmed'?'已确认':complete(b)?'已对齐':b.status==='conflict'?'待核对':b.status==='partial'?'部分对齐':'待观察'}));
    let alignment='',missing='';
    if(!target)alignment=allCovered?'本场各重点已有支持或人工确认，可以收束。':'先设置本场想表达的重点，再对照当前内容。';
    else if(!focus) {
      alignment=fresh?'刚才的原话尚未与这个重点建立足够联系；它是接下来要核对的目标。':'当前没有足够新近的可靠语句，先展示接下来要讲的目标。';
      missing=`待衔接：${shortMeaning(goal,78)}`;
    } else if(focus.manual && complete(focus)) {
      alignment='这一重点已由你确认讲清；最近相关原话见上方。';
      missing=slow.queue.length?`下一项：${label(slow.queue.find(b=>b.allocatedSeconds>0) || slow.queue[0])}`:'本场重点均已确认，可以回扣主题。';
    } else if(focus.semantic?.facets.length) {
      const facets=focus.semantic.facets, supported=facets.filter(f=>f.state==='supported'), conflicts=facets.filter(f=>f.state==='conflict'), rest=facets.filter(f=>!['supported','conflict'].includes(f.state));
      alignment=supported.length?`本点累计 ${supported.length}/${facets.length} 条含义已有支持：${supported.slice(0,2).map(f=>quote(f.claim)).join('、')}`:'已出现相关表达，完整含义尚未确认。';
      if(conflicts.length)missing=`核对 ${quote(conflicts[0].claim)}：${conflicts[0].issues?.join('；') || '当前表述与目标含义尚不一致'}。`;
      else if(rest.length)missing=`还需核实：${rest.slice(0,2).map(f=>quote(f.claim)).join('、')}${rest.length>2?`，另有 ${rest.length-2} 条见依据`:''}。`;
      else missing='这一重点的必要含义已有支持，可以继续推进。';
      if(focus.manual && !complete(focus))missing='你已标记仍需补讲。'+missing;
    } else {
      const supported=focus.claims.filter(c=>c.matched),rest=focus.claims.filter(c=>!c.matched);
      alignment=supported.length?`文字已对应 ${supported.length}/${focus.claims.length} 项：${supported.slice(0,1).map(c=>quote(c.text)).join('、')}；含义仍可在依据中复核。`:`最近原话与${quote(goal)}部分相关，尚不能确认完整。`;
      missing=rest.length?`还需核实：${quote(rest[0].text)}${rest[0].guard?`（${rest[0].guard}）`:''}。`:'预设文字已有对应，继续展开下一点。';
      if(focus.manual && !complete(focus))missing='你已标记仍需补讲。'+missing;
    }
    const done=beats.filter(complete).length,partial=beats.filter(b=>b.status==='partial').length,conflicts=beats.filter(b=>b.status==='conflict').length;
    let overall=beats.length?`${done}/${beats.length} 个重点已完整对齐或确认${partial?`，${partial} 个部分对齐`:''}${conflicts?`，${conflicts} 个表述待核对`:''}。`:'尚未设置本场重点。';
    const delivery=slow.overall?.delivery || [];
    if(delivery.length)overall+=delivery[0];
    else if(finite(slow.overall?.pace) && slow.overall?.speechSeconds>=30)overall+=`已观测语音均速 ${Math.round(slow.overall.pace)} 字/分，处于本场参考范围。`;
    else overall+='语音样本仍少，暂不评价整场声音表现。';
    let outlookKind='room',outlook=`还剩 ${clock(slow.remaining)}；按设定，待核实项补讲约需 ${Math.ceil(slow.allCost)} 秒，已另留 ${Math.round(slow.reserve)} 秒收尾。`;
    if(!beats.length){outlookKind='waiting';outlook='设置重点和时限后，再估计补讲是否来得及。';}
    else if(slow.remaining<=0){outlookKind='ended';outlook=`时间已到，${slow.queue.length?`${slow.queue.length} 项留到复盘核对`:'本场重点已有支持或确认'}。`;}
    else if(!slow.queue.length){outlookKind='complete';outlook=`重点已覆盖，余 ${clock(slow.remaining)}，可用一句话回扣主题。`;}
    else if(!slow.queue.some(b=>b.allocatedSeconds>0)){outlookKind='closing';outlook=`余 ${clock(slow.remaining)}，补讲预算不足，先收尾；未确认项留到复盘。`;}
    else if(slow.budget<slow.allCost){outlookKind='tight';outlook=`补讲预算 ${slow.budget} 秒，按设定需 ${Math.ceil(slow.allCost)} 秒；先保留「${label(slow.queue.find(b=>b.allocatedSeconds>0))}」的结论，压缩其他展开。`;}
    const next=slow.queue.find(b=>b.allocatedSeconds>0);
    const nextStep=next && slow.remaining>slow.reserve?`优先核对：${label(next)}${next.deadline<t?'（已过计划截止点）':next.deadline-t<=30?`（距计划截止 ${Math.ceil(next.deadline-t)} 秒）`:''}`:'';
    return {...raw,title:target?`${focus?'当前重点':'下一重点'}：${headline}`:allCovered?'预设重点已覆盖，准备收束':'先设置本场重点',status:allCovered&&!focus?'准备收束':labels[raw.kind] || '待核对',goal:shortMeaning(goal,100),current:excerpt?`“${shortMeaning(excerpt,96)}”`:'尚无这段已结束的可靠语句。',alignment,missing,overall,outlook,outlookKind,statuses,targetId:target?.id || null,targetSource:focus?'observed':allCovered?'complete':'planned',nextStep,
      summary:`${alignment} ${missing}`,gaps:`${overall} ${outlook}${nextStep?' '+nextStep:''}`};
  }
  function contentReviewEvidence(beats,units,t,slow) {
    const recent=units.filter(u=>u.time_span[1]<=t && u.time_span[1]>Math.max(0,t-30) && Number(u.reliability?.text || 0)>=.6);
    const last=recent.at(-1),observedAt=last?.time_span[1] ?? null;
    const usable=last && t-observedAt<=12 && clean(recent.map(u=>u.text).join(" ")).length>=8;
    const pending=slow.queue,done=beats.filter(complete).length;
    const label=b=>`「${goalLabel(b.title)}」`;
    let gaps;
    if(!pending.length) gaps=`${beats.length?`${beats.length} 个预设重点均已有支持或人工确认。`:"还没有设置本场重点。"}${slow.remaining>0?"可以用一句话回扣主题。":"本场时间已到，可转入复盘。"}`;
    else if(slow.remaining<=0) gaps=`本场时间已到，${pending.length} 个重点仍待确认；优先把${label(pending[0])}留在复盘中核对。`;
    else if(slow.budget===0 || !pending.some(b=>b.allocatedSeconds>0)) gaps=`剩余 ${clock(slow.remaining)}，先收尾。${pending.length} 个重点待确认，来不及展开的留到复盘。`;
    else {
      const next=pending.find(b=>b.allocatedSeconds>0),second=pending.find(b=>b.id!==next.id && b.allocatedSeconds>0);
      const action=next.status==="conflict"?"先核对":next.status==="partial"?"先确认是否已讲完整":"接着确认";
      gaps=`整体还有 ${pending.length} 个重点待确认。${action}${label(next)}${second?`，再看${label(second)}`:""}。`;
      gaps+=slow.budget<slow.allCost?`剩余 ${clock(slow.remaining)}，优先说结论，减少展开。`:next.deadline-t<=30?`这一点${next.deadline<t?"已到预设截止点":`距预设截止 ${Math.ceil(next.deadline-t)} 秒`}，留意推进。`:`剩余 ${clock(slow.remaining)}，按优先顺序推进。`;
    }
    const base={kind:"waiting",title:"先听一小段，再看表达效果",summary:"收到可靠的已结束语句后，会对照你设定的重点给出简短评价。",gaps,observedAt,done,total:beats.length,focusId:null,excerpt:"",basis:"最近 30 秒表达 · 对照本场重点"};
    if(!usable) return {...base,title:last?"等下一段，再继续判断":"先听一小段，再看表达效果",summary:last?"刚才的表达已记录，当前可靠内容还不够，暂不下新的结论。":base.summary};
    const local=assess(beats.map(b=>({...b,claims:b.claims.map(c=>typeof c==="string"?c:c.text)})),recent,[],t);
    const candidates=[];
    for(const b of beats) {
      const lexical=local.find(x=>x.id===b.id);
      const fresh=f=>f.evidence && finite(f.evidence.end) && f.evidence.end<=t && f.evidence.end>t-30;
      const facets=b.semantic?.facets.filter(f=>fresh(f) && ["supported","related","conflict"].includes(f.state)) || [];
      const conflict=facets.find(f=>f.state==="conflict"),supported=facets.find(f=>f.state==="supported"),related=facets.find(f=>f.state==="related");
      const claim=lexical?.claims.filter(c=>c.score>=.55 && c.evidence).sort((a,b)=>b.score-a.score)[0];
      const facet=conflict || supported || related;
      if(!facet && !claim)continue;
      // Once semantic facets cover this beat, a weak lexical overlap cannot overrule them.
      if(b.semantic && !facet && !b.manual && b.semantic.at>=claim?.end)continue;
      const kind=b.manual?(complete(b)?"confirmed":"partial"):conflict || (!facet && claim?.guard)?"conflict":complete(b)?"supported":"partial";
      const at=facet?.evidence.end ?? claim.end;
      candidates.push({beat:b,kind,at,evidence:facet?.evidence.text ?? claim.evidence,
        issues:conflict?.issues || (claim?.guard?[claim.guard]:[]),strength:facet?({conflict:4,supported:3,related:2})[facet.state]:claim.score});
    }
    candidates.sort((a,b)=>b.at-a.at || b.strength-a.strength);
    const focus=candidates[0];
    if(!focus)return {...base,kind:"unmatched",title:"当前表达还未对应到预设重点",summary:"最近这段还没有找到足够的对应证据。若正在铺垫，可以用一句话引回想表达的核心意思。",excerpt:shortMeaning(recent.slice(-2).map(u=>u.text).join(" "),80)};
    const target=label(focus.beat),result={...base,kind:focus.kind,focusId:focus.beat.id,excerpt:shortMeaning(focus.evidence,120)};
    if(focus.kind==="conflict")return {...result,title:"讲到了相关重点，表述还需核对",summary:`刚才的内容与${target}相关，但${focus.issues.length?focus.issues.slice(0,2).join("、"):"关键事实"}。确认后再继续展开。`};
    if(focus.kind==="confirmed")return {...result,title:"这一点已确认，继续推进",summary:`当前表达对应${target}；你已确认这点讲清，可以接着讲下一项。`};
    if(focus.kind==="supported")return {...result,title:"这一点已有支持，可以继续推进",summary:`最近的表达对应${target}；截至目前，这一点的必要含义已有匹配证据。`};
    return {...result,title:"已讲到相关内容，还需确认完整",summary:`最近内容与${target}相关；${focus.beat.manual?"你已标记这点仍需补讲。":"还不能确认所有必要含义都已说清。"}`};
  }
  // Visible movement descriptions only. Missing coefficients are unknown, never zero.
  function visualState(data,t) {
    const samples=[...new Map((data.visual_observations?.observations || [])
      .filter(v=>finite(v.timestamp) && v.timestamp<=t && v.timestamp>=t-6)
      .map(v=>[v.timestamp,v])).values()].sort((a,b)=>a.timestamp-b.timestamp);
    const last=samples.at(-1), fresh=last && t-last.timestamp<=3;
    const empty={title:"等待新画面",detail:"当前没有足够新近的视觉样本。"};
    if(!fresh)return {at:null,sampleCount:0,gesture:{...empty},face:{...empty},note:"视觉证据不足，暂不判断动作；声音监测继续。"};
    const usable=h=>h?.visible===true && (!finite(h.visibility) || h.visibility>=.5);
    const hands=Object.entries(last.pose?.hands || {}).filter(([,h])=>usable(h));
    const positions={above_shoulder:"肩部上方",torso_level:"躯干附近",below_waist:"腰部下方"};
    let gesture={title:"手部未检出",detail:"可能在画面外、被遮挡或未被模型识别，暂不评价手势。"};
    if(hands.length) {
      const motion=hands.filter(([,h])=>!last.scene_change_candidate && finite(h.speed_body_per_second) && h.comparison_interval_seconds>0 && h.comparison_interval_seconds<=2.5 && ["clear_motion","small_motion"].includes(h.movement));
      const moving=motion.some(([,h])=>h.movement==="clear_motion");
      const raised=hands.filter(([,h])=>h.position==="above_shoulder");
      let title=raised.length?"手部抬至肩上":moving?"手部正在移动":"手部位置可见";
      const detail=hands.map(([side,h])=>`${side==="left"?"左手":"右手"}：${positions[h.position] || "位置已检出"}`).join("；");
      const same=samples.filter(s=>Object.values(s.pose?.hands || {}).some(h=>usable(h) && h.position==="above_shoulder")).length;
      gesture={title,detail:detail+(raised.length && same>=2?`。近 6 秒 ${same} 个样本出现肩上手位。`:"。")+(motion.length?moving?"可比较样本中检测到手部移动。":"可比较样本中手部移动较小。":"当前样本不足以可靠比较移动幅度。")};
    }
    let face={title:"面部未检出",detail:"可能是远景、侧脸或切到幻灯片，暂不判断面部动作。"};
    if(last.face?.visible===true) {
      const f=last.face, coefficients=f.blendshape_scores || {};
      const score=name=>finite(coefficients[name])?coefficients[name]:f.visible_features?.find(v=>v.name===name)?.score;
      const above=(name,n)=>finite(score(name)) && score(name)>=n;
      const both=(name,n)=>above(name+"Left",n) && above(name+"Right",n);
      const features=[];
      if(both("mouthSmile",.45))features.push("嘴角上扬");
      if(above("jawOpen",.4))features.push("张口动作");
      if(above("mouthPucker",.55))features.push("嘴部收拢");
      if(above("browInnerUp",.5))features.push("眉部上提");
      if(both("eyeBlink",.6))features.push("双眼闭合动作");
      if(both("eyeLookDown",.55))features.push("眼部向下动作");
      face={title:features.slice(0,2).join(" · ") || "面部可见",detail:features.length?"当前帧检测到的面部动作，仅作观察，不代表情绪或表达质量。":"当前样本未检出突出动作信号；单帧不足以判断神态变化。"};
    }
    return {at:last.timestamp,sampleCount:samples.length,gesture,face,note:`近 6 秒 ${samples.length} 个画面样本 · 仅描述可见动作；不将镜头切换或未检出视为演讲问题。`};
  }
  // Coaching thresholds are project heuristics, not statistics from champion speeches.
  // They offer a conditional next action, never an emotion or performance score.
  function visualCoach(data,t,units=[],limit=Infinity) {
    let samples=[...new Map((data.visual_observations?.observations || [])
      .filter(v=>finite(v.timestamp) && v.timestamp<=t && v.timestamp>=t-12)
      .map(v=>[v.timestamp,v])).values()].sort((a,b)=>a.timestamp-b.timestamp);
    const last=samples.at(-1);
    const cue=(code,title,reason,evidence,reference,kind="suggestion",priority=20)=>({code,title,reason,evidence,reference,kind,priority,severity:kind==="suggestion"?1:0,observedAt:last?.timestamp ?? t,retainCodes:[]});
    if(limit-t<=Math.min(20,limit*.08))return cue("visual-close","先完成收尾","先用一句话回扣主题，动作细节留到场后回看。","已进入本场预留收尾时间。","优先讲清最后的结论。","timing",100);
    const insufficient=(why)=>cue("visual-wait","先等清晰画面",why,"暂不作针对个人的动作建议。","先取得连续、可辨认的画面。","insufficient",0);
    if(!last || t-last.timestamp>3)return insufficient("当前没有新近视觉样本；声音监测继续。");
    // Never accumulate evidence across a known cut or a sampling gap.
    for(let i=samples.length-1;i>=0;i--)if(samples[i].scene_change_candidate || (i>0 && samples[i].timestamp-samples[i-1].timestamp>2.5)){samples=samples.slice(i);break;}
    const hand=(v,side)=>{const h=v.pose?.hands?.[side];return h?.visible && (!finite(h.visibility) || h.visibility>=.6)?h:null;};
    const handsVisible=v=>!!(hand(v,"left") || hand(v,"right"));
    const coefficient=(v,name)=>{const f=v.face;if(!f?.visible)return null;const n=f.blendshape_scores?.[name] ?? f.visible_features?.find(x=>x.name===name)?.score;return finite(n) && n>=0 && n<=1?n:null;};
    const down=v=>coefficient(v,"eyeLookDownLeft")>=.6 && coefficient(v,"eyeLookDownRight")>=.6 && !(coefficient(v,"eyeBlinkLeft")>=.5 || coefficient(v,"eyeBlinkRight")>=.5);
    const streak=predicate=>{const result=[];for(let i=samples.length-1;i>=0;i--){const v=samples[i];if(!predicate(v) || (result.length && v.face?.view!==result.at(-1).face?.view))break;result.push(v);}return result.reverse();};
    const sustained=xs=>xs.length>=4 && xs.at(-1).timestamp-xs[0].timestamp>=6;
    const eye=streak(down);
    if(sustained(eye))return cue("visual-eye","试着抬眼交流","先核对是否一直在看稿；若是，讲下一句时可以看向听众。正在读图或演示时，按内容需要继续。",`${clock(eye[0].timestamp)}–${clock(last.timestamp)}，连续 ${eye.length} 个样本识别到双侧眼部向下动作；尚不能确认实际注视对象。`,"讲完整个意思，再自然转向另一位听众。","suggestion",40);
    for(const side of ["left","right"]) {
      const raised=streak(v=>hand(v,side)?.position==="above_shoulder");
      if(sustained(raised))return cue("visual-release","强调后可收手","若这段强调已结束，可以让手回到自然位置；正在指图、说明高度或做有意义的动作时可继续。",`${clock(raised[0].timestamp)}–${clock(last.timestamp)}，连续 ${raised.length} 个样本把${side==="left"?"左":"右"}手识别在肩部上方。`,"手势有表达目的，结束后自然放松。","suggestion",30);
    }
    if(!last.face?.visible && !handsVisible(last))return insufficient("当前未清楚检出面部或手部，可能是远景、遮挡或幻灯片。");
    if(samples.length<2 || last.timestamp-samples[0].timestamp<2)return insufficient("先观察连续几帧，再判断是否值得调整；单帧不作纠正。");
    const recent=units.filter(u=>u.time_span?.[1]<=t && u.time_span[1]>=t-6 && u.reliability?.text>=.6).slice(-2);
    const text=recent.map(u=>u.text).join(" "),speechEnd=recent.at(-1)?.time_span[1];
    const context=(code,title,action,reference,pattern)=>{
      const matched=text.match(pattern);if(!matched)return null;
      return {...cue(code,title,action,`刚才 ${clock(speechEnd)} 的转写出现“${matched[0]}”；当前有手部可见样本，建议结合实际含义选用。`,reference),observedAt:speechEnd};
    };
    if(handsVisible(last) && samples.filter(handsVisible).length>=2 && recent.length) {
      const suggestion=context("visual-contrast","用手势作对照","下一次讲到两项对比时，可用左右两侧分别示意；如果不是在作对比，就保持原来的自然动作。","让手势帮助听众理解内容关系。",/相比|相比较|对比|一方面|另一方面|前者|后者|而不是/)
        || context("visual-list","给要点配手势","下一次逐条讲要点时，可用手指或分点手势辅助编号，讲完自然收回。","用有意义的手势区分主要观点。",/(?:第一|第二|第三|第四)(?:点|个|项|步)|(?:分为|有)[两三四]个(?:方面|原因|重点|问题|部分)/)
        || context("visual-emphasis","手势落在重点","下一句关键结论，可用一次简短手势配合重音；无需每个词都做动作。","动作与重要词句相配合，保持自然。",/因此|所以|总之|关键是|结论是|这意味着/);
      if(suggestion)return suggestion;
    }
    return cue("visual-natural","自然展开就好","先把这一句讲完整，有需要时再用手势帮助解释。","当前样本未触发个别调整建议，不代表已经达到某个大师水平。","动作与神态随内容变化，无需强行增加手势或微笑。","reference",0);
  }
  function evaluate(data,t,plan,limit,rows=[],speaker="",manual=[],semantic=null,fastProfile="active") {
    const units=availableUnits(data,t), beats=mergeSemantic(assess(plan,units,manual,t),semantic,t), m=metrics(units,t);
    const history=baseline(rows,speaker,data,clamp(t/limit,0,1),planKey(plan,limit),intentKey(data,plan),semantic?.version || "lexical-1.0");
    const coverage=beats.length ? beats.filter(complete).length/beats.length : 0;
    const visuals=(data.visual_observations?.observations || []).filter(v=>finite(v.timestamp) && v.timestamp<=t && v.timestamp>=t-4);
    const whole=metrics(units,t,Infinity), slow=schedule(beats,t,limit,history);
    const delivery=[];
    const paceRules=FAST_PROFILES[fastProfile] || FAST_PROFILES.active;
    if(whole.seconds>=30 && Math.round(whole.pace)>paceRules.high) delivery.push("本场整体语速偏快，补讲时减少展开，留出句间停顿。");
    if(whole.seconds>=30 && whole.pace!==null && Math.round(whole.pace)<paceRules.low) delivery.push("本场整体语速偏慢，若非刻意强调，可适当提速，把下一句连贯说完。");
    if(whole.seconds>=30 && whole.pitch!==null && whole.pitch<2) delivery.push("已观测语音的音高起伏较小，讲关键结论时可增加轻重变化。");
    slow.overall={pending:beats.filter(b=>!complete(b)).length,partial:beats.filter(b=>b.status==="partial").length,pace:whole.pace,pitch:whole.pitch,speechSeconds:whole.seconds,delivery};
    slow.review=contentReview(beats,units,t,slow);
    const fastMetrics=recentMetrics(units,t),content=contentCue(beats,units,t,slow);
    return {t,units,beats,metrics:m,fastMetrics,paceState:paceState(fastMetrics,t,fastProfile),history,coverage,visual:visuals.at(-1) || null,visualState:visualState(data,t),visualCoach:visualCoach(data,t,units,limit),
      fast:combineFastCue(fastCue(fastMetrics,history,units,t,limit-t,beats,slow.reserve,limit,fastProfile),content),slow};
  }
  class FastCueGate {
    constructor(holdSeconds=8) {this.holdSeconds=holdSeconds;this.events=[];this.reset();}
    reset(clearHistory=true) {this.current=null;this.since=0;this.calmSince=null;this.lastT=null;this.lastClock=null;if(clearHistory)this.events=[];}
    show(cue,t,visibleClock) {
      if((this.lastT!==null && t<this.lastT) || (this.lastClock!==null && visibleClock<this.lastClock))this.reset();
      this.lastT=t;this.lastClock=visibleClock;
      const key=c=>c.actionKey || `${c.code}:${c.beatId || ""}`;
      const accept=()=>{this.current=cue.severity>0 || cue.sticky?{...cue}:null;this.since=visibleClock;this.calmSince=null;if(this.current){this.events.push({at:t,visibleAt:visibleClock,title:cue.title,code:cue.code,reason:cue.reason,observedAt:cue.observedAt,...(cue.reference?{reference:cue.reference,evidence:cue.evidence,kind:cue.kind}:{})});this.events=this.events.slice(-100);}return {...cue,phase:"current",holdRemaining:this.current?this.holdSeconds:0};};
      if(!this.current)return accept();
      // An opposite measured pace needs the opposite action immediately.
      if(["pace","slow"].includes(cue.code) && ["pace","slow"].includes(this.current.code) && cue.code!==this.current.code)return accept();
      if(key(cue)===key(this.current)) {if(cue.priority>this.current.priority)return accept();this.current={...cue,title:this.current.title,severity:Math.max(cue.severity,this.current.severity),priority:Math.max(cue.priority,this.current.priority)};this.calmSince=null;return {...this.current,phase:"current",holdRemaining:Math.max(0,this.holdSeconds-(visibleClock-this.since))};}
      if(cue.priority>this.current.priority)return accept();
      const retained=cue.retainCodes?.includes(this.current.code);
      if(!retained && this.calmSince===null)this.calmSince=visibleClock;
      if(retained)this.calmSince=null;
      const heldFor=visibleClock-this.since,holdRemaining=Math.max(0,this.holdSeconds-heldFor);
      if(heldFor>=this.holdSeconds && (cue.severity>0 || (this.calmSince!==null && visibleClock-this.calmSince>=2)))return accept();
      return {...this.current,phase:retained?"recovering":"held",holdRemaining,currentCue:cue};
    }
  }
  class ReminderGate {
    constructor() { this.events=[]; }
    push(cue,t) {
      if(!cue.needsReminder) return null;
      const prior=this.events.filter(e=>e.at<=t), last=prior.at(-1);
      // Keep one of the three interruption slots for closing/deadline risk.
      if(prior.length>=(cue.terminal ? 3 : 2) || (last && t-last.at<25) || prior.some(e=>e.key===cue.key)) return null;
      const event={at:t,key:cue.key,title:cue.title,reason:cue.reason}; this.events.push(event); return event;
    }
    rewind(t) { this.events=this.events.filter(e=>e.at<=t); }
  }
  root.StageEngine={VERSION,MONITOR_BUILD,FAST_WINDOW,FAST_PROFILES,mean,finite,clock,hash,clean,clamp,duration,sourceKey,intentKey,defaultPlan,availableUnits,assess,mergeSemantic,metrics,recentMetrics,paceState,visualState,visualCoach,histories,baseline,planKey,fastCue,evaluate,complete,shortMeaning,contentReview,FastCueGate,ReminderGate};
})(globalThis);
