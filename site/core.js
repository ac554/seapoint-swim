'use strict';
const DAY=86400000,HOUR=3600000,MIN=60000;
const TZ='Europe/Dublin';
const dublinFormatter = new Intl.DateTimeFormat('en-GB',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function dublinParts(t){
  const p=Object.fromEntries(dublinFormatter.formatToParts(new Date(t)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
function localToUtc(d,t){
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(d)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))return NaN;
  const guess=Date.parse(`${d}T${t}:00Z`),p=dublinParts(guess);
  const wall=Date.parse(`${p.date}T${p.time}:00Z`);
  let target=guess-(wall-guess);
  const q=dublinParts(target);
  if(`${q.date} ${q.time}`!==`${d} ${t}`){const r=dublinParts(target+HOUR);if(`${r.date} ${r.time}`===`${d} ${t}`)target+=HOUR;}
  return target;
}
function fmtTime(t){return new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(t)}
function parseTideCsv(csv){
  const lines=csv.trim().split(/\r?\n/); if(lines.length<5) return [];
  const hdr=lines[0].split(',').map(x=>x.trim().replaceAll('"',''));
  const i=hdr.indexOf('time'),j=hdr.indexOf('Water_Level');if(i<0||j<0||!/metres?|meters?/i.test(lines[1]))return [];
  const pts=[];
  for(const line of lines.slice(2)){const p=line.split(','); const t=Date.parse(p[i]),v=Number(p[j]);if(Number.isFinite(t)&&Number.isFinite(v))pts.push({t,h:v});}
  return pts.sort((a,b)=>a.t-b.t);
}
function extrema(points){
  const res=[];for(let i=1;i<points.length-1;i++){
    const a=points[i-1],b=points[i],c=points[i+1];
    let type=null;if(b.h>=a.h&&b.h>c.h)type='high';else if(b.h<=a.h&&b.h<c.h)type='low';
    if(!type)continue;
    const prev=res[res.length-1];
    if(prev && b.t-prev.t<3.5*HOUR){ if(prev.type===type&&((type==='high'&&b.h>prev.h)||(type==='low'&&b.h<prev.h)))res[res.length-1]={...b,type}; continue;}
    res.push({...b,type});
  }
  return res;
}
function interpolatedLevel(points,t){
  if(points.length<2||t<points[0].t||t>points[points.length-1].t)return null;
  let lo=0,hi=points.length-1;
  while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(points[mid].t<=t)lo=mid;else hi=mid;}
  const a=points[lo],b=points[hi];if(t===a.t)return a.h;if(t===b.t)return b.h;if(b.t-a.t>30*MIN)return null;return a.h+(b.h-a.h)*(t-a.t)/(b.t-a.t);
}
function fallbackEvents(table){return table.map(({date,time,height,type})=>({t:localToUtc(date,time),h:height,type})).filter(e=>Number.isFinite(e.t)).sort((a,b)=>a.t-b.t)};
function nearestHigh(events,t){const highs=events.filter(e=>e.type==='high');if(!highs.length)return null;
  const high=highs.reduce((x,y)=>Math.abs(y.t-t)<Math.abs(x.t-t)?y:x);
  if(Math.abs(high.t-t)>10*HOUR)return null;
  const span=Math.min(4,Math.max(2,3+(high.h-3.85)*1.0));
  return {...high,start:high.t-span*HOUR,end:high.t+span*HOUR,half:span};
}
function tideInfo(points,events,t){
  const high=nearestHigh(events,t);if(!high)return {valid:false,detail:'No tide prediction for this time'};
  const lows=events.filter(e=>e.type==='low');
  const before=[...lows].filter(e=>e.t<high.t).at(-1)||null;
  const after=lows.find(e=>e.t>high.t)||null;
  const low=t<=high.t?before:after;
  const level=points.length?interpolatedLevel(points,t):null;
  const aboveLow=level!=null&&low!=null?+(level-low.h).toFixed(2):null;
  return {valid:true,high:{at:high.t,height:high.h},low:low?{at:low.t,height:low.h}:null,
    window:{start:high.start,end:high.end,hours:high.half},inside:t>=high.start&&t<=high.end,
    selectedLevel:level!=null?+level.toFixed(2):null,aboveLow,range:low?+(high.h-low.h).toFixed(2):null,
    datum:points.length?'LAT':'Dublin Port chart datum',heuristic:true};
}
function atHour(f,date,time,maxGap=40){
  const hourly=f?.hourly;if(!Array.isArray(hourly?.time))return null;
  const target=localToUtc(date,time);
  let best=-1,bestDiff=Infinity;
  for(let i=0;i<hourly.time.length;i++){
    const s=hourly.time[i];const u=f.utcTime ? Date.parse(s.endsWith('Z')?s:s+'Z') : localToUtc(s.slice(0,10),s.slice(11,16));
    const diff=Math.abs(u-target);if(diff<bestDiff){best=i;bestDiff=diff;}
  }
  if(best<0||bestDiff>maxGap*MIN)return null;
  const value={};for(const [k,arr] of Object.entries(hourly))if(k!=='time'&&Array.isArray(arr))value[k]=arr[best]??null;
  return value;
}
function windStatus(kn,gust,deg){
  if(!Number.isFinite(kn))return {status:'unknown',short:'No forecast'};
  const onshore=Number.isFinite(deg)&&(deg>=315||deg<=105);
  if(kn>=24||(onshore&&kn>=19)||(Number.isFinite(gust)&&gust>=29))return {status:'avoid',short:'Strong or rough'};
  if(kn>=16||(onshore&&kn>=13)||(Number.isFinite(gust)&&gust>=22))return {status:'caution',short:'Breezy / choppy'};
  return {status:'good',short:'Light to moderate'};
}
function waveStatus(h){if(!Number.isFinite(h))return {status:'unknown',short:'No forecast'};
  if(h>=1)return {status:'avoid',short:'Rough seas'};
  if(h>=0.6)return {status:'caution',short:'Noticeable waves'};
  return {status:'good',short:h<0.35?'Relatively calm':'Some chop possible'};
}
/** Standard NWS/US-Canada wind-chill index, valid at or below 10 °C and wind >4.8 km/h.
 * This estimates dry, exposed skin, not the much faster cooling of wet skin on exit. */
function windChillC(airC,windKn){
  if(!Number.isFinite(airC)||!Number.isFinite(windKn)||airC>10||windKn*1.852<=4.8)return null;
  const v=windKn*1.852;
  return 13.12+0.6215*airC-11.37*Math.pow(v,.16)+.3965*airC*Math.pow(v,.16);
}
/** Cold-water shock is a risk below 15 °C (RNLI). For an acclimatised swimmer,
 * water temperature alone is *not* a reason to reject otherwise calm swimming weather.
 * A very cold exit, both sea and air, is a planning caution, not a medical limit. */
function temperatureStatus(seaC,airC,feelsC,windKn,seaSource='forecast'){
  const seaValid=Number.isFinite(seaC),airValid=Number.isFinite(airC),feelValid=Number.isFinite(feelsC);
  const coldWater=seaValid&&seaC<15;
  const veryColdSea=seaValid&&seaC<=9;
  const coldExit=veryColdSea&&feelValid&&feelsC<=0&&Number.isFinite(windKn)&&windKn>=4&&seaSource==='forecast';
  let note='';
  if(!seaValid&&!airValid) note='Temperature forecasts unavailable; check the water and conditions at the beach.';
  else if(!seaValid) note='Water temperature unavailable. Check the water locally before entering.';
  else if(coldExit) note='Very cold water and a freezing-feeling exit. Keep the swim brief and have warm, dry layers ready.';
  else if(coldWater) note='Cold-water shock risk below 15°C. Enter carefully, and have warm clothes ready for afterwards.';
  else if(feelValid&&feelsC<5) note='Cool on exit, particularly with wet skin. Have warm, dry layers ready.';
  else note='Water and air temperatures are shown as forecasts, not readings at the steps.';
  return {status:coldExit?'caution':'info',coldWater,coldExit,note};
}
function activeWarnings(feed,t){if(!Array.isArray(feed))return null;
  return feed.filter(w=>{
    const r=w.regions||[];
    if(!r.includes('EI810')&&!r.includes('EI07'))return false;
    const from=Date.parse(w.onset||w.issued||''),to=Date.parse(w.expiry||'');
    return (!Number.isFinite(from)||t>=from)&&(!Number.isFinite(to)||t<=to);
  }).map(w=>({headline:w.headline||'Marine/weather warning',type:w.type||'',level:w.level||'Yellow'}));
}
function normaliseAlerts(json,t){
  const all=Array.isArray(json)?json:Array.isArray(json?.list)?json.list:Array.isArray(json?.data)?json.data:Array.isArray(json?.items)?json.items:null;
  if(!all)return {verified:false,active:[]};
  const complete=!(json?.count&&Number(json.count)>all.length);
  const beach='IEEABWC090_0000_0100';
  const active=all.filter(x=>{
    const str=JSON.stringify(x).toUpperCase();if(!str.includes(beach))return false;
    const start=x.start_date||x.from_date||x.startDate||x.start||x.date_from;
    const end=x.end_date||x.to_date||x.endDate||x.end||x.date_to;
    const begin=Date.parse(start),stop=Date.parse(end);
    return (!Number.isFinite(begin)||t>=begin)&&(!Number.isFinite(stop)||t<=stop+DAY-1);
  }).map(x=>({title:String(x.description||x.alert_type||x.reason||'EPA bathing alert')}));
  return {verified:complete,active};
}
function isDay(weather,date,time){
  const i=weather?.daily?.time?.indexOf(date)??-1;
  if(i>=0&&weather.daily.sunrise?.[i]&&weather.daily.sunset?.[i]){
    const t=localToUtc(date,time),rise=localToUtc(date,weather.daily.sunrise[i].slice(11,16)),set=localToUtc(date,weather.daily.sunset[i].slice(11,16));
    return {ok:t>=rise+15*MIN&&t<=set-25*MIN,rise:fmtTime(rise),set:fmtTime(set)};
  }
  const h=atHour(weather,date,time);
  return h&&Number.isFinite(h.is_day)?{ok:!!h.is_day}: {ok:null};
}
function assess({date,time,points=[],events=[],wind=null,waves=null,seaTemp=null,buoyTemp=null,warningFeed=null,alertsFeed=null,sources={},now=Date.now()}){
  const selected=localToUtc(date,time);const tide=tideInfo(points,events,selected);
  const wh=atHour(wind,date,time),wv=atHour(waves,date,time);
  const wk=wh?.wind_speed_10m!=null?Number(wh.wind_speed_10m):null;
  const gust=wh?.wind_gusts_10m!=null?Number(wh.wind_gusts_10m):null;
  const wavesM=wv?.wave_height!=null?Number(wv.wave_height):null;
  const windGrade=windStatus(wk,gust,wh?.wind_direction_10m!=null?Number(wh.wind_direction_10m):null);
  const waveGrade=waveStatus(wavesM);
  const airC=wh?.temperature_2m!=null?Number(wh.temperature_2m):null;
  const seaRow=atHour(seaTemp,date,time);
  const modelSeaC=seaRow?.sea_surface_temperature!=null?Number(seaRow.sea_surface_temperature):null;
  // The M2 buoy is offshore. Only use its temperature as a clearly labelled
  // last resort for a near-now selected time; never imply it measures Seapoint.
  const selectedNearNow=Math.abs(selected-now)<=3*HOUR;
  const useBuoy= !Number.isFinite(modelSeaC)&&selectedNearNow&&buoyTemp?.fresh&&Number.isFinite(buoyTemp?.waterC);
  const waterC=Number.isFinite(modelSeaC)?modelSeaC:useBuoy?buoyTemp.waterC:null;
  const seaKind=Number.isFinite(modelSeaC)?'forecast':useBuoy?'offshore observation':'unavailable';
  const chill=windChillC(airC,wk);
  const apparentC=wh?.apparent_temperature!=null?Number(wh.apparent_temperature):null;
  const feelsC=chill!=null?chill:apparentC;
  const feelsLabel=chill!=null?'Wind chill':'Feels like';
  const thermal=temperatureStatus(waterC,airC,feelsC,wk,seaKind);
  const light=isDay(wind,date,time);
  const warningList=activeWarnings(warningFeed,selected);
  const alerts=normaliseAlerts(alertsFeed,selected);
  const severeWarning=warningList?.find(w=>/orange|red|gale/i.test(w.level+' '+w.type));
  const warning=warningList?.[0]||null;
  let status='good',headline='Looks good for a swim',explanation='The tide and sea forecast look favourable.';
  const chosenPast=Number.isFinite(selected)&&selected<now-20*MIN;
  if(chosenPast){status='unknown';headline='Choose an upcoming time';explanation='This forecast is intended for future swims.';}
  else if(!tide.valid){status='unknown';headline='No tide prediction';explanation='Cannot assess the swim window without tide information.';}
  else if(light.ok===false){status='avoid';headline='Not a good time';explanation='It is dark or too close to sunset.';}
  else if(!tide.inside){status='avoid';headline='Better closer to high tide';explanation='Outside your approximate high-tide swimming window.';}
  else if(severeWarning||alerts.active.length){status='avoid';headline='Do not swim';explanation=severeWarning?.headline||'A bathing-water alert applies to Seapoint.';}
  else if(windGrade.status==='avoid'||waveGrade.status==='avoid'){status='avoid';headline='Sea likely too rough';explanation='Wind or wave conditions look unsuitable.';}
  else if(windGrade.status==='unknown'||waveGrade.status==='unknown'||light.ok===null){status='unknown';headline='Not enough information';explanation='A tide, wave or wind forecast is missing.';}
  else if(warning||windGrade.status==='caution'||waveGrade.status==='caution'){status='caution';headline='Could be choppy';explanation=warning?warning.headline:'Some chop is likely. Check the entry steps.';}
  else if(thermal.coldExit){status='caution';headline='Cold on exit';explanation='The sea looks calm, but very cold water and wind chill make getting out especially chilly.';}
  else if(thermal.coldWater){headline='Sea looks good · cold water';explanation='Tide, wind and waves look favourable for an experienced cold-water swimmer.';}
  const caveats=[];
  if(!warningList)caveats.push('Marine warnings could not be checked');
  if(!alerts.verified)caveats.push('Bathing alerts could not be checked');
  if(alerts.verified&&!alerts.active.length)caveats.push('No active bathing alerts found in checked feed');
  if(sources?.tides?.fallback)caveats.push('Using a dated published tide table');
  return {date,time,at:new Date(selected).toISOString(),status,headline,explanation,
    tide,waves:{heightM:wavesM,periodS:wv?.wave_period??null,...waveGrade},wind:{speedKn:wk,gustKn:gust,direction:wh?.wind_direction_10m??null,...windGrade},
    temperature:{waterC,airC,feelsC,feelsLabel,windChillC:chill,apparentC,seaKind,waterSource:seaKind==='forecast'?'Open-Meteo marine SST model':seaKind==='offshore observation'?'Marine Institute M2 offshore buoy':'Unavailable',...thermal},
    daylight:light,warnings:{verified:warningList!==null,active:warningList||[]},water:alerts,caveats};
}
function slots(input,date){return Array.from({length:20},(_,i)=>{const time=`${String(Math.floor((9*60+i*30)/60)).padStart(2,'0')}:${String((i*30)%60).padStart(2,'0')}`;const r=assess({...input,date,time});return {time,status:r.status}});}
const SeapointCore={dublinParts,localToUtc,fmtTime,parseTideCsv,extrema,interpolatedLevel,fallbackEvents,nearestHigh,tideInfo,atHour,windStatus,waveStatus,activeWarnings,normaliseAlerts,isDay,windChillC,temperatureStatus,assess,slots};
if(typeof module!=="undefined"&&module.exports)module.exports=SeapointCore;
if(typeof window!=="undefined")window.SeapointCore=SeapointCore;
