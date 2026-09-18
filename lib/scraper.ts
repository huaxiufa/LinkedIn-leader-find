import { chromium, type Locator, type Page } from "playwright";
import { lookup } from "node:dns/promises";
import { normalizeLinkedInUrl } from "./normalize";

export type ScrapedEngagement = { profileUrl:string; name:string; headline?:string; jobTitle?:string; company?:string; type:"COMMENT"|"REACTION"; reactionType?:string; commentText?:string; engagedAt?:Date };
export type ScrapeResult = { engagements:ScrapedEngagement[]; warnings:string[] };
const clean=(v:string|null|undefined)=>(v??"").replace(/\s+/g," ").trim();
const profile=(v:string)=>{const u=normalizeLinkedInUrl(v);return /linkedin\.com\/in\//i.test(u)?u:"";};
const SCRAPER_DOM_VERSION="2026-09-18-reactions-before-comments-v10";
const generic=(v:string)=>/^(like|comment|repost|send|follow|most relevant|most recent|reactions?|likes?|people who reacted|close|cancel|done|back|next|previous|see all|show more|load more|connections?|grow your network|my network|notifications?|messaging|jobs|home|search|me|for business|celebrate|support|love|insightful|funny)$/i.test(clean(v))||clean(v).length<2;
async function connect(){const configured=new URL(process.env.LINKEDIN_CDP_URL??"http://host.docker.internal:9222");let host=configured.hostname;if(!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)&&host!=="localhost"){const a=await lookup(host,{all:true});const v4=a.find(x=>x.family===4);if(!v4)throw new Error(`Could not resolve ${host} to IPv4.`);host=v4.address;}const endpoint=`http://${host}:${configured.port||"9222"}`;const r=await fetch(`${endpoint}/json/version`,{headers:{Host:host}});if(!r.ok)throw new Error(`Chrome CDP endpoint returned HTTP ${r.status}.`);const v=await r.json() as {Browser?:string;webSocketDebuggerUrl?:string};console.log(`Chrome CDP browser: ${v.Browser??"unknown"}`);if(!v.webSocketDebuggerUrl)throw new Error("Chrome CDP did not return a browser WebSocket endpoint.");const browser=await chromium.connectOverCDP(v.webSocketDebuggerUrl,{timeout:90000});const context=browser.contexts()[0];if(!context)throw new Error("Chrome CDP connected, but no browser context is available.");return {browser,page:await context.newPage()};}
async function nearestClickable(node:Locator){const c=node.locator("xpath=ancestor-or-self::*[self::button or @role='button' or self::a][1]");return await c.count().catch(()=>0)?c.first():node;}
async function controls(page:Page,kind:"comments"|"reactions",postUrl:string){const countRe=kind==="comments"?/\b\d[\d,.]*\s+comments?\b/i:/\b\d[\d,.]*\s+(?:reactions?|likes?)\b/i;const labelRe=kind==="comments"?/comment/i:/reaction|like/i;const all=page.locator("button,[role='button'],a,[tabindex='0'],span");const n=Math.min(await all.count().catch(()=>0),1800);const hits:string[]=[];for(let i=0;i<n;i++){const x=all.nth(i);const text=clean(await x.innerText().catch(()=>""));const aria=clean(await x.getAttribute("aria-label").catch(()=>""));const title=clean(await x.getAttribute("title").catch(()=>""));const data=clean(await x.getAttribute("data-view-name").catch(()=>""));const s=`${text} ${aria} ${title} ${data}`;if(labelRe.test(s)&&hits.length<30)hits.push(s.slice(0,140));if(countRe.test(text)||countRe.test(aria)||countRe.test(title))return nearestClickable(x);}console.log(`${kind} control diagnostics: ${hits.join(" | ")||"no labelled candidates"}`);return null;}
async function selectMostRecentComments(page:Page){
  const relevantCandidates=[
    page.getByRole("button",{name:/^Most relevant$/i}).first(),
    page.locator('button').filter({hasText:/^Most relevant$/i}).first(),
    page.locator('[role="button"]').filter({hasText:/^Most relevant$/i}).first(),
    page.getByText(/^Most relevant$/i).first()
  ];
  let relevant:Locator|null=null;
  for(const candidate of relevantCandidates){
    if(await candidate.count().catch(()=>0)&&await candidate.isVisible().catch(()=>false)){relevant=candidate;break;}
  }
  if(!relevant){console.log("Comment sort control: Most relevant not visible; continuing with current comment view.");return false;}
  console.log("Comment sort control found: Most relevant; opening sort menu.");
  await relevant.scrollIntoViewIfNeeded().catch(()=>{});
  await relevant.click({timeout:5000}).catch(async()=>{const c=await nearestClickable(relevant!);await c.click({timeout:5000,force:true}).catch(()=>{});});
  await page.waitForTimeout(500);
  const optionCandidates=[
    page.getByRole("menuitem",{name:/^Most recent$/i}).first(),
    page.getByRole("option",{name:/^Most recent$/i}).first(),
    page.getByRole("button",{name:/^Most recent$/i}).first(),
    page.locator('[role="menu"] [role="menuitem"],[role="listbox"] [role="option"],[role="listbox"] button').filter({hasText:/^Most recent$/i}).first(),
    page.locator('button').filter({hasText:/^Most recent$/i}).first(),
    page.getByText(/^Most recent$/i).first()
  ];
  let recent:Locator|null=null;
  for(const candidate of optionCandidates){
    if(await candidate.count().catch(()=>0)&&await candidate.isVisible().catch(()=>false)){recent=candidate;break;}
  }
  if(!recent){console.log("Comment sort menu opened, but Most recent option was not found.");return false;}
  console.log("Comment sort option found: Most recent; clicking option.");
  await recent.scrollIntoViewIfNeeded().catch(()=>{});
  let clicked=false;
  try{await recent.click({timeout:5000,force:true});clicked=true;}catch{}
  if(!clicked){
    try{const c=await nearestClickable(recent);await c.click({timeout:5000,force:true});clicked=true;}catch{}
  }
  if(!clicked){
    try{const box=await recent.boundingBox();if(box){await page.mouse.click(box.x+box.width/2,box.y+box.height/2);clicked=true;}}catch{}
  }
  await page.waitForTimeout(1500);
  let selected=false;
  const verifyCandidates=[
    page.getByRole("button",{name:/^Most recent$/i}).first(),
    page.locator('button').filter({hasText:/^Most recent$/i}).first(),
    page.locator('[aria-checked="true"],[aria-pressed="true"]').filter({hasText:/Most recent/i}).first()
  ];
  for(const candidate of verifyCandidates){
    if(await candidate.count().catch(()=>0)&&await candidate.isVisible().catch(()=>false)){selected=true;break;}
  }
  if(!selected){
    console.log("Comment sort control: Most recent click was not verified; continuing without claiming the switch.");
    return false;
  }
  console.log("Comment sort control: verified Most recent is selected.");
  for(let i=0;i<10;i++){
    const markers=page.locator('button[aria-label^="View more options for " i][aria-label$=" comment." i]');
    if(await markers.count().catch(()=>0)>0){console.log("Comment sort: comment markers are now loaded.");break;}
    await page.waitForTimeout(500);
  }
  return true;
}
async function clickControl(page:Page,c:Locator,label:string){console.log(`${label} control found; clicking it.`);await c.scrollIntoViewIfNeeded().catch(()=>{});await c.click({timeout:5000}).catch(async()=>c.click({timeout:5000,force:true}));await page.waitForTimeout(1200);}
async function extractComments(page:Page,max:number,postUrl:string){const c=await controls(page,"comments",postUrl);if(c)await clickControl(page,c,"Comment interaction");else console.log("Comment count control not found; scanning current comment UI only.");await selectMostRecentComments(page);for(let pass=0;pass<15;pass++){const more=page.locator("button,[role='button'],a").filter({hasText:/load more comments?|more comments?|show more comments?/i}).first();if(await more.count().catch(()=>0)&&await more.isVisible().catch(()=>false)){await more.click({timeout:3000}).catch(()=>{});await page.waitForTimeout(500);}await page.mouse.wheel(0,1000).catch(()=>{});await page.waitForTimeout(300);}const markers=page.locator('button[aria-label^="View more options for " i][aria-label$=" comment." i]');const markerCount=Math.min(await markers.count().catch(()=>0),1000);const out:ScrapedEngagement[]=[];const seen=new Set<string>();for(let i=0;i<markerCount&&out.length<max;i++){const marker=markers.nth(i);if(!(await marker.isVisible().catch(()=>false)))continue;const label=clean(await marker.getAttribute("aria-label").catch(()=> ""));let node=marker;let chosen:Locator|null=null;for(let level=0;level<28;level++){const anchors=node.locator('a[href*="/in/"]');const n=Math.min(await anchors.count().catch(()=>0),8);if(n>0){const expandable=node.locator('[data-testid="expandable-text-box"]');const reply=node.locator('button[aria-label="Reply"],button,[role="button"]').filter({hasText:/^reply$/i});if((await expandable.count().catch(()=>0))>0||(await reply.count().catch(()=>0))>0||/View more options for .+comment/i.test(label)){chosen=node;break;}}const parent=node.locator("xpath=..");if(!(await parent.count().catch(()=>0)))break;node=parent;}if(!chosen)continue;const anchors=chosen.locator('a[href*="/in/"]');const n=Math.min(await anchors.count().catch(()=>0),8);let href="",name="";for(let j=0;j<n;j++){const a=anchors.nth(j);if(!(await a.isVisible().catch(()=>false)))continue;const h=profile(await a.getAttribute("href").catch(()=> ""));const raw=clean((await a.innerText().catch(()=> ""))||(await a.getAttribute("aria-label").catch(()=> "")));const nm=raw.split(/•|\n/)[0].trim();if(h&&nm&&!generic(nm)&&!seen.has(h.toLowerCase())){href=h;name=nm;break;}}if(!href||!name)continue;const bodyNodes=chosen.locator('[data-testid="expandable-text-box"]');let body="";if(await bodyNodes.count().catch(()=>0))body=clean(await bodyNodes.first().innerText().catch(()=> ""));else{const lines=clean(await chosen.innerText().catch(()=> "")).split(/\n+/).map(clean).filter(Boolean);const idx=lines.findIndex(x=>x.toLowerCase().includes(name.toLowerCase()));body=idx>=0?lines.slice(idx+1).filter(x=>!/^(like|reply|follow|edited|see more|see less|translate)$/i.test(x)).join(" ").slice(0,5000):"";}seen.add(href.toLowerCase());out.push({profileUrl:href,name,type:"COMMENT",commentText:body||undefined});}console.log("Comment DOM diagnostics: semantic comment markers="+markerCount+", captured="+out.length);return out;}
async function findPostReactionControl(page:Page,postUrl:string):Promise<Locator|null>{
  const postCandidates=page.locator('article, [data-urn*="activity"], [data-id*="urn:li:activity"], [data-urn*="ugcPost"], [data-id*="ugcPost"]');
  const postCount=Math.min(await postCandidates.count().catch(()=>0),30);
  for(let i=0;i<postCount;i++){
    const post=postCandidates.nth(i);
    if(!(await post.isVisible().catch(()=>false)))continue;
    const text=clean(await post.innerText().catch(()=>""));
    if(!/\\breactions?\\b/i.test(text))continue;
    const controls=post.locator('button,[role="button"],a');
    const controlCount=Math.min(await controls.count().catch(()=>0),300);
    for(let j=0;j<controlCount;j++){
      const c=controls.nth(j);
      const label=clean((await c.innerText().catch(()=>""))||(await c.getAttribute("aria-label").catch(()=>""))||(await c.getAttribute("title").catch(()=>"")));
      if(/\\b\\d+\\s+reactions?\\b/i.test(label)||/\\breactions?\\b/i.test(label)&&!/like|comment|share|send/i.test(label)){
        console.log(`Post reaction-count control matched inside post: "${label}"`);
        return c;
      }
    }
  }
  const controls=page.locator('button,[role="button"],a');
  const count=Math.min(await controls.count().catch(()=>0),2000);
  const candidates:string[]=[];
  for(let i=0;i<count;i++){
    const c=controls.nth(i);
    if(!(await c.isVisible().catch(()=>false)))continue;
    const label=clean((await c.innerText().catch(()=>""))||(await c.getAttribute("aria-label").catch(()=>""))||(await c.getAttribute("title").catch(()=>"")));
    if(!/^\\d+\\s+reactions?$/i.test(label)&&!/^\\d+\\s+likes?$/i.test(label))continue;
    const nearby=clean(await c.locator("xpath=..").innerText().catch(()=>""));
    if(/my network|connections|grow your network|notifications|messaging/i.test(nearby))continue;
    console.log(`Post reaction-count control matched by fallback: "${label}"`);
    return c;
  }
  console.log(`Post reaction-count diagnostics: no count control found; candidates=${candidates.join(" | ")||"none"}`);
  return null;
}
async function snapshotVisibleProfiles(page:Page){
  const anchors=page.locator('a[href*="/in/"],a[data-profile-url],a[data-test-profile-url]');
  const out=new Map<string,{href:string,name:string}>();
  const n=Math.min(await anchors.count().catch(()=>0),3000);
  for(let i=0;i<n;i++){const a=anchors.nth(i);if(!(await a.isVisible().catch(()=>false)))continue;const href=profile((await a.getAttribute("href").catch(()=> ""))||(await a.getAttribute("data-profile-url").catch(()=> ""))||(await a.getAttribute("data-test-profile-url").catch(()=> ""))||"");const raw=clean((await a.innerText().catch(()=> ""))||(await a.getAttribute("aria-label").catch(()=> "")));const name=raw.split(/•|\\n/)[0].trim();if(href&&name&&!generic(name))out.set(href.toLowerCase(),{href,name});}return out;
}
async function reactionProfilesAfterClick(page:Page,before:Map<string,{href:string,name:string}>,max:number){
  for(let round=0;round<20;round++){const now=await snapshotVisibleProfiles(page);const fresh=[...now.values()].filter(x=>!before.has(x.href.toLowerCase()));if(fresh.length){console.log("Reaction DOM diagnostics: new profile anchors after reaction click="+fresh.length);return fresh.slice(0,max).map(x=>({profileUrl:x.href,name:x.name,type:"REACTION" as const,reactionType:"UNKNOWN"}));}await page.waitForTimeout(300);}return [];
}
async function extractReactions(page:Page,max:number,postUrl:string,warnings:string[]){const before=await snapshotVisibleProfiles(page);const c=await findPostReactionControl(page,postUrl);if(!c){warnings.push("Could not locate the reaction interaction control inside the LinkedIn post.");return [];}await clickControl(page,c,"Reaction interaction");const fresh=await reactionProfilesAfterClick(page,before,max);if(fresh.length){console.log("Reaction extraction: captured "+fresh.length+" newly exposed profile(s) after clicking reaction count.");return fresh;}console.log("Reaction DOM diagnostics: reaction click produced no newly exposed profile anchors.");warnings.push("Reaction dialog did not appear after opening the reaction interaction.");return [];}
export async function scrapePublicPost(postUrl:string,options:{maxComments?:number;maxReactions?:number}={}):Promise<ScrapeResult>{console.log(`Scraper DOM version: ${SCRAPER_DOM_VERSION}`);const maxComments=options.maxComments??500,maxReactions=options.maxReactions??500,warnings:string[]=[];const {browser,page}=await connect();try{await page.goto(postUrl,{waitUntil:"domcontentloaded",timeout:30000});await page.waitForTimeout(2000);const signedOut=await page.locator('input[name="session_key"],form[action*="login"]').count().catch(()=>0);console.log(`LinkedIn session: ${signedOut?"SIGNED OUT":"SIGNED IN"}`);if(signedOut)warnings.push("LinkedIn appears to be signed out in the connected Chrome profile.");// Extract reactions before opening the comment sort menu.
    // LinkedIn's comment sorting UI can alter the post DOM and hide the reaction count.
    // This preserves the proven extraction order from the working baseline.
    const reactions=await extractReactions(page,maxReactions,postUrl,warnings);
    const comments=await extractComments(page,maxComments,postUrl);const merged=new Map<string,ScrapedEngagement>();for(const item of [...reactions,...comments]){const key=normalizeLinkedInUrl(item.profileUrl).toLowerCase();if(!key)continue;const old=merged.get(key);if(!old||item.type==="COMMENT")merged.set(key,item);}console.log(`Engagement merge: comments=${comments.length}, reactions=${reactions.length}, unique=${merged.size}.`);return{engagements:[...merged.values()],warnings};}finally{await page.close().catch(()=>{});await browser.close().catch(()=>{});}}