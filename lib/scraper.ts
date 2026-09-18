import { chromium, type Locator, type Page } from "playwright";
import { lookup } from "node:dns/promises";
import { normalizeLinkedInUrl } from "./normalize";

export type ScrapedEngagement = { profileUrl:string; name:string; headline?:string; jobTitle?:string; company?:string; type:"COMMENT"|"REACTION"; reactionType?:string; commentText?:string; engagedAt?:Date };
export type ScrapeResult = { engagements:ScrapedEngagement[]; warnings:string[] };
const clean=(v:string|null|undefined)=>(v??"").replace(/\s+/g," ").trim();
const profile=(v:string)=>{const u=normalizeLinkedInUrl(v);return /linkedin\.com\/in\//i.test(u)?u:"";};
const SCRAPER_DOM_VERSION="2026-09-18-post-reaction-control-comment-marker-v2";
const generic=(v:string)=>/^(like|comment|repost|send|follow|most relevant|most recent|reactions?|likes?|people who reacted|close|cancel|done|back|next|previous|see all|show more|load more|connections?|grow your network|my network|notifications?|messaging|jobs|home|search|me|for business|celebrate|support|love|insightful|funny)$/i.test(clean(v))||clean(v).length<2;
async function connect(){const configured=new URL(process.env.LINKEDIN_CDP_URL??"http://host.docker.internal:9222");let host=configured.hostname;if(!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)&&host!=="localhost"){const a=await lookup(host,{all:true});const v4=a.find(x=>x.family===4);if(!v4)throw new Error(`Could not resolve ${host} to IPv4.`);host=v4.address;}const endpoint=`http://${host}:${configured.port||"9222"}`;const r=await fetch(`${endpoint}/json/version`,{headers:{Host:host}});if(!r.ok)throw new Error(`Chrome CDP endpoint returned HTTP ${r.status}.`);const v=await r.json() as {Browser?:string;webSocketDebuggerUrl?:string};console.log(`Chrome CDP browser: ${v.Browser??"unknown"}`);if(!v.webSocketDebuggerUrl)throw new Error("Chrome CDP did not return a browser WebSocket endpoint.");const browser=await chromium.connectOverCDP(v.webSocketDebuggerUrl,{timeout:90000});const context=browser.contexts()[0];if(!context)throw new Error("Chrome CDP connected, but no browser context is available.");return {browser,page:await context.newPage()};}
async function nearestClickable(node:Locator){const c=node.locator("xpath=ancestor-or-self::*[self::button or @role='button' or self::a][1]");return await c.count().catch(()=>0)?c.first():node;}
async function controls(page:Page,kind:"comments"|"reactions",postUrl:string){const countRe=kind==="comments"?/\b\d[\d,.]*\s+comments?\b/i:/\b\d[\d,.]*\s+(?:reactions?|likes?)\b/i;const labelRe=kind==="comments"?/comment/i:/reaction|like/i;const all=page.locator("button,[role='button'],a,[tabindex='0'],span");const n=Math.min(await all.count().catch(()=>0),1800);const hits:string[]=[];for(let i=0;i<n;i++){const x=all.nth(i);if(!(await x.isVisible().catch(()=>false)))continue;const text=clean(await x.innerText().catch(()=>""));const aria=clean(await x.getAttribute("aria-label").catch(()=>""));const title=clean(await x.getAttribute("title").catch(()=>""));const data=clean(await x.getAttribute("data-view-name").catch(()=>""));const s=`${text} ${aria} ${title} ${data}`;if(labelRe.test(s)&&hits.length<30)hits.push(s.slice(0,140));if(countRe.test(text)||countRe.test(aria)||countRe.test(title))return nearestClickable(x);}console.log(`${kind} control diagnostics: ${hits.join(" | ")||"no labelled candidates"}`);return null;}
function overlayCandidates(page:Page){return page.locator('[role="dialog"],[role="listbox"],[role="list"],[role="tabpanel"],.artdeco-modal,.artdeco-popover,[data-test-modal],[data-test-dialog],[data-test-popover]');}
function profileAnchors(page:Page|Locator){return page.locator('a[href*="/in/"],a[data-profile-url],a[data-test-profile-url]');}
async function snapshotProfileVisibility(page:Page){const seen=new Map<string,boolean>();const anchors=profileAnchors(page);const n=Math.min(await anchors.count().catch(()=>0),2500);for(let i=0;i<n;i++){const a=anchors.nth(i);const href=profile((await a.getAttribute("href").catch(()=>""))||(await a.getAttribute("data-profile-url").catch(()=>""))||(await a.getAttribute("data-test-profile-url").catch(()=>""))||"");if(href)seen.set(href.toLowerCase(),await a.isVisible().catch(()=>false));}return seen;}
async function reactionSurfaceAfterClick(page:Page){for(let i=0;i<12;i++){const specific=overlayCandidates(page).filter({hasText:/people who reacted|\breactions?\b|\blikes?/i}).last();if(await specific.count().catch(()=>0))return specific;await page.waitForTimeout(300);}return null;}
function commentSurface(page:Page){return overlayCandidates(page).filter({hasText:/comment|reply/i}).last();}
async function clickControl(page:Page,c:Locator,label:string){console.log(`${label} control found; clicking it.`);await c.scrollIntoViewIfNeeded().catch(()=>{});await c.click({timeout:5000}).catch(async()=>c.click({timeout:5000,force:true}));await page.waitForTimeout(1200);}
async function climbComment(anchor:Locator){
  let node=anchor;
  for(let i=0;i<40;i++){
    const text=clean(await node.textContent().catch(()=> ""));
    const cls=clean((await node.getAttribute("class").catch(()=> ""))+" "+(await node.getAttribute("data-view-name").catch(()=> ""))+" "+(await node.getAttribute("data-test-id").catch(()=> "")));
    const hasReply=await node.locator("button,[role='button'],a").filter({hasText:/^reply$/i}).count().catch(()=>0);
    if(hasReply && text.length<15000 && /\breply\b/i.test(text)) return node;
    if(/(^|[\s_-])comment(?!ary)/i.test(cls) && text.length<15000 && /\breply\b/i.test(text)) return node;
    const p=node.locator("xpath=..");
    if(!(await p.count().catch(()=>0))) break;
    node=p;
  }
  return null;
}
async function extractComments(page:Page,max:number,postUrl:string){
  const c=await controls(page,"comments",postUrl);
  if(c) await clickControl(page,c,"Comment interaction");
  else console.log("Comment count control not found; scanning current comment UI only.");

  // LinkedIn's current DOM can omit the legacy .comments-comment-item class.
  // Each real comment still exposes a stable semantic marker on its options
  // button: aria-label="View more options for <name>'s comment."
  // We anchor extraction on that marker instead of scanning every /in/ link.
  for(let pass=0;pass<15;pass++){
    const more=page.locator("button,[role='button'],a").filter({hasText:/load more comments?|more comments?|show more comments?/i}).first();
    if(await more.count().catch(()=>0)&&await more.isVisible().catch(()=>false)){
      await more.click({timeout:3000}).catch(()=>{});
      await page.waitForTimeout(500);
    }
    await page.mouse.wheel(0,1000).catch(()=>{});
    await page.waitForTimeout(300);
  }

  const markers=page.locator('button[aria-label^="View more options for " i][aria-label$=" comment." i]');
  const markerCount=Math.min(await markers.count().catch(()=>0),1000);
  const out:ScrapedEngagement[]=[];
  const seen=new Set<string>();

  for(let i=0;i<markerCount&&out.length<max;i++){
    const marker=markers.nth(i);
    if(!(await marker.isVisible().catch(()=>false))) continue;
    const label=clean(await marker.getAttribute("aria-label").catch(()=> ""));
    if(!/comment/i.test(label)) continue;

    let node=marker;
    let chosen:Locator|null=null;
    for(let level=0;level<28;level++){
      const anchors=node.locator('a[href*="/in/"]');
      const n=Math.min(await anchors.count().catch(()=>0),8);
      if(n>0){
        const expandable=node.locator('[data-testid="expandable-text-box"]');
        const reply=node.locator('button[aria-label="Reply"],button,[role="button"]').filter({hasText:/^reply$/i});
        const txt=clean(await node.innerText().catch(()=> ""));
        if((await expandable.count().catch(()=>0))>0 || (await reply.count().catch(()=>0))>0 || /View more options for .+comment/i.test(label)){
          chosen=node;
          break;
        }
      }
      const parent=node.locator("xpath=..");
      if(!(await parent.count().catch(()=>0))) break;
      node=parent;
    }
    if(!chosen) continue;

    const anchors=chosen.locator('a[href*="/in/"]');
    const n=Math.min(await anchors.count().catch(()=>0),8);
    let href="",name="";
    for(let j=0;j<n;j++){
      const a=anchors.nth(j);
      if(!(await a.isVisible().catch(()=>false))) continue;
      const h=profile(await a.getAttribute("href").catch(()=> ""));
      const raw=clean((await a.innerText().catch(()=> ""))||(await a.getAttribute("aria-label").catch(()=> "")));
      const nm=raw.split(/•|\\n/)[0].trim();
      if(h&&nm&&!generic(nm)&&!seen.has(h.toLowerCase())){href=h;name=nm;break;}
    }
    if(!href||!name) continue;

    const bodyNodes=chosen.locator('[data-testid="expandable-text-box"]');
    let body="";
    if(await bodyNodes.count().catch(()=>0)){
      body=clean(await bodyNodes.first().innerText().catch(()=> ""));
    }else{
      const lines=clean(await chosen.innerText().catch(()=> "")).split(/\n+/).map(clean).filter(Boolean);
      const idx=lines.findIndex(x=>x.toLowerCase().includes(name.toLowerCase()));
      body=idx>=0?lines.slice(idx+1).filter(x=>!/^(like|reply|follow|edited|see more|see less|translate)$/i.test(x)).join(" ").slice(0,5000):"";
    }

    seen.add(href.toLowerCase());
    out.push({profileUrl:href,name,type:"COMMENT",commentText:body||undefined});
  }

  console.log("Comment DOM diagnostics: semantic comment markers="+markerCount+", captured="+out.length);
  if(!markerCount) console.log("Comment DOM diagnostics: no button[aria-label*=comment] markers found.");
  return out;
}
async function findPostReactionControl(page:Page,postUrl:string):Promise<Locator|null>{
  // LinkedIn does not reliably expose the post id in data-urn/data-id. The
  // stable rendered signal is the post-level reaction count such as
  // "3 reactions" / "3 likes". Scan visible UI text/ARIA and climb to the
  // nearest clickable element. Reject comment-level reaction controls.
  const all=page.locator("button,a,[role='button'],span,div");
  const n=Math.min(await all.count().catch(()=>0),3500);
  const countRe=/^\s*\d[\d,.]*\s+(?:reactions?|likes?)\s*$/i;
  let fallback:Locator|null=null;
  for(let i=0;i<n;i++){
    const x=all.nth(i);
    if(!(await x.isVisible().catch(()=>false))) continue;
    const text=clean(await x.innerText().catch(()=>""));
    const aria=clean(await x.getAttribute("aria-label").catch(()=>""));
    const title=clean(await x.getAttribute("title").catch(()=>""));
    const s=text+" "+aria+" "+title;
    if(/reaction button state|comment reaction|^reply$/i.test(s)) continue;
    if(countRe.test(text)||countRe.test(aria)||countRe.test(title)){
      const clickable=await nearestClickable(x);
      if(await clickable.isVisible().catch(()=>false)) return clickable;
    }
    if(/(?:view|open|see).*?(?:reactions?|likes?)/i.test(s) && !/comment|reply/i.test(s)) fallback=await nearestClickable(x);
  }
  if(fallback && await fallback.isVisible().catch(()=>false)) return fallback;
  return null;
}
async function extractReactions(page:Page,max:number,postUrl:string,warnings:string[]){
  const c=await findPostReactionControl(page,postUrl);
  if(!c){warnings.push("Could not locate the reaction interaction control inside the LinkedIn post.");return [];}
  await clickControl(page,c,"Reaction interaction");

  // Authoritative DOM path: reaction dialog only.
  // Never harvest /in/ links from the underlying post/page because those are
  // unrelated people such as the author or hover-card targets.
  let dialog:Locator|null=null;
  for(let i=0;i<12;i++){
    const dialogs=page.locator('div[role="dialog"]');
    const n=Math.min(await dialogs.count().catch(()=>0),20);
    for(let j=n-1;j>=0;j--){
      const d=dialogs.nth(j);
      if(!(await d.isVisible().catch(()=>false))) continue;
      const anchors=d.locator('a[href*="/in/"]');
      const text=clean(await d.innerText().catch(()=> ""));
      if((await anchors.count().catch(()=>0))>0 || /people who reacted|reactions?|likes?/i.test(text)){dialog=d;break;}
    }
    if(dialog)break;
    await page.waitForTimeout(300);
  }

  if(!dialog){
    warnings.push("Reaction dialog did not appear after opening the reaction interaction.");
    console.log("Reaction DOM diagnostics: div[role=dialog] not found.");
    return [];
  }

  const reactions:ScrapedEngagement[]=[];
  const seen=new Set<string>();
  for(let round=0;round<30 && reactions.length<max;round++){
    const anchors=dialog.locator('a[href*="/in/"]');
    const n=Math.min(await anchors.count().catch(()=>0),2000);
    let added=0;
    for(let i=0;i<n && reactions.length<max;i++){
      const a=anchors.nth(i);
      if(!(await a.isVisible().catch(()=>false))) continue;
      const href=profile(await a.getAttribute("href").catch(()=> ""));
      const name=clean((await a.innerText().catch(()=> ""))||(await a.getAttribute("aria-label").catch(()=> ""))).split(/•|\\n/)[0].trim();
      const key=href.toLowerCase();
      if(!href||!name||generic(name)||seen.has(key)) continue;
      seen.add(key);
      reactions.push({profileUrl:href,name,type:"REACTION",reactionType:"UNKNOWN"});
      added++;
    }

    const more=dialog.locator("button,[role='button'],a").filter({hasText:/load more|show more|more reactions|see more/i}).first();
    if(await more.count().catch(()=>0)&&await more.isVisible().catch(()=>false)){
      await more.click({timeout:3000}).catch(()=>{});
      await page.waitForTimeout(650);
    }else{
      await dialog.mouse.wheel(0,1200).catch(()=>{});
      await page.waitForTimeout(450);
    }

    if(!added && !(await more.count().catch(()=>0))) break;
  }

  console.log("Reaction DOM diagnostics: div[role=dialog] profile anchors="+reactions.length);
  if(!reactions.length) warnings.push("Reaction dialog opened, but no public LinkedIn profile URLs were found inside div[role=dialog].");
  return reactions;
}
export async function scrapePublicPost(postUrl:string,options:{maxComments?:number;maxReactions?:number}={}):Promise<ScrapeResult>{console.log(`Scraper DOM version: ${SCRAPER_DOM_VERSION}`);const maxComments=options.maxComments??500,maxReactions=options.maxReactions??500,warnings:string[]=[];const {browser,page}=await connect();try{await page.goto(postUrl,{waitUntil:"domcontentloaded",timeout:30000});await page.waitForTimeout(2000);const signedOut=await page.locator('input[name="session_key"],form[action*="login"]').count().catch(()=>0);console.log(`LinkedIn session: ${signedOut?"SIGNED OUT":"SIGNED IN"}`);if(signedOut)warnings.push("LinkedIn appears to be signed out in the connected Chrome profile.");const comments=await extractComments(page,maxComments,postUrl);const reactions=await extractReactions(page,maxReactions,postUrl,warnings);const merged=new Map<string,ScrapedEngagement>();for(const item of [...reactions,...comments]){const key=normalizeLinkedInUrl(item.profileUrl).toLowerCase();if(!key)continue;const old=merged.get(key);if(!old||item.type==="COMMENT")merged.set(key,item);}console.log(`Engagement merge: comments=${comments.length}, reactions=${reactions.length}, unique=${merged.size}.`);return{engagements:[...merged.values()],warnings};}finally{await page.close().catch(()=>{});await browser.close().catch(()=>{});}}
