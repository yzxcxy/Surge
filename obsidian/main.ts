import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import { deriveKey, makeOp, materialize, fetchInfo, exchange } from '../web/core.mjs';

type Op = { id:string; noteId:string; field:string; clock:number; actor:string; ciphertext:string; localPending?:boolean };
type Note = { id:string; title:string; body:string; folder:string; pinned:boolean; deleted:boolean; background:string; updatedAt:number };
type State = { server:string; token:string; salt:string; actor:string; clock:number; cursor:number; ops:Op[] };
const initial = ():State => ({ server:'', token:'', salt:'', actor:crypto.randomUUID(), clock:0, cursor:0, ops:[] });
const clean = (op:Op) => ({ id:op.id, noteId:op.noteId, field:op.field, clock:op.clock, actor:op.actor, ciphertext:op.ciphertext });
const safe = (s:string) => s.replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0,80) || '未命名笔记';
const parse = (text:string) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  const id = m?.[1].match(/^surge-id:\s*([a-f0-9-]{36})\s*$/m)?.[1] || null;
  const rest = m ? text.slice(m[0].length) : text;
  const title = rest.match(/^# (.*)(?:\n|$)/)?.[1] || '';
  const body = title ? rest.replace(/^# .*\n?\n?/, '') : rest;
  return { id, title, body:body.replace(/\n+$/, '') };
};
const render = (note:Note) => `---\nsurge-id: ${note.id}\n---\n# ${note.title || '未命名笔记'}\n\n${note.body}${note.body ? '\n' : ''}`;

class PassphraseModal extends Modal {
  constructor(app:App, private onSubmit:(value:string)=>void) { super(app); }
  onOpen() { this.titleEl.setText('解锁 Surge'); const input = this.contentEl.createEl('input', { type:'password', placeholder:'加密口令' }); input.style.width='100%'; const button = this.contentEl.createEl('button', { text:'解锁并同步' }); button.onclick=()=>{ const value=input.value; this.close(); this.onSubmit(value); }; input.onkeydown=e=>{ if(e.key==='Enter') button.click(); }; input.focus(); }
  onClose() { this.contentEl.empty(); }
}

export default class SurgePlugin extends Plugin {
  state:State = initial(); key:CryptoKey|null = null; notes = new Map<string,Note>(); busy = false; applying = new Set<string>(); pathToId = new Map<string,string>(); timers = new Map<string,number>();
  async onload() {
    this.state = Object.assign(initial(), await this.loadData() || {});
    this.addSettingTab(new SurgeSettings(this.app, this));
    this.addCommand({ id:'unlock-sync', name:'解锁并同步', callback:()=>new PassphraseModal(this.app, value=>this.unlock(value)).open() });
    this.addRibbonIcon('refresh-cw', '同步 Surge', ()=>this.sync());
    this.registerEvent(this.app.vault.on('create', file=>{ if(file instanceof TFile) this.queueLocal(file); }));
    this.registerEvent(this.app.vault.on('modify', file=>{ if(file instanceof TFile) this.queueLocal(file); }));
    this.registerEvent(this.app.vault.on('rename', file=>{ if(file instanceof TFile) this.queueLocal(file); }));
    this.registerEvent(this.app.vault.on('delete', file=>{ const id=this.pathToId.get(file.path); if(id && this.key && !this.applying.has(file.path)) this.saveField(id,'deleted',true).then(()=>this.sync()); this.pathToId.delete(file.path); }));
    this.registerInterval(window.setInterval(()=>this.sync(),30000));
  }
  async save() { await this.saveData(this.state); }
  async unlock(passphrase:string) {
    try {
      if(!this.state.server || !this.state.token) throw new Error('请先设置服务器地址和访问令牌');
      let salt=this.state.salt;
      try { salt=(await fetchInfo(this.state.server)).salt; }
      catch(e) { if(!salt) throw e; }
      if(this.state.salt && salt!==this.state.salt && this.state.ops.length) throw new Error('服务器与本地笔记不匹配');
      this.state.salt=salt; await this.save();
      const key=await deriveKey(passphrase,salt);
      const result=await materialize(this.state.ops,key);
      this.key=key; this.notes=result.notes as Map<string,Note>; this.state.clock=Math.max(this.state.clock,result.maxClock);
      new Notice('Surge 已解锁');
      for(const file of this.app.vault.getMarkdownFiles().filter(f=>f.path.startsWith('Surge/'))) await this.fromFile(file);
      await this.sync();
    } catch(e:any) { new Notice(e.name==='OperationError'?'Surge 加密口令错误':`Surge: ${e.message}`); }
  }
  async saveField(id:string, field:string, value:any) {
    if(!this.key) return;
    const op=await makeOp(this.key,this.state.actor,++this.state.clock,id,field,value) as Op;
    op.localPending=true; this.state.ops.push(op); await this.save();
    const note=this.notes.get(id) || { id,title:'',body:'',folder:'',pinned:false,deleted:false,background:'paper',updatedAt:0 };
    (note as any)[field]=value; this.notes.set(id,note);
  }
  queueLocal(file:TFile) { if(!this.key || !file.path.startsWith('Surge/') || file.extension!=='md' || this.applying.has(file.path)) return; clearTimeout(this.timers.get(file.path)); this.timers.set(file.path,window.setTimeout(()=>{ this.timers.delete(file.path); this.fromFile(file).then(()=>this.sync()).catch(e=>new Notice(`Surge: ${e.message}`)); },350)); }
  async fromFile(file:TFile) {
    if(!this.key || this.applying.has(file.path) || !this.app.vault.getAbstractFileByPath(file.path)) return;
    const content=await this.app.vault.read(file); const parsed=parse(content);
    const id=parsed.id || crypto.randomUUID();
    const folder=file.parent?.path==='Surge'?'':(file.parent?.path||'').replace(/^Surge\//,'');
    const existing=this.notes.get(id);
    if(!parsed.id) {
      this.applying.add(file.path);
      await this.app.vault.modify(file,`---\nsurge-id: ${id}\n---\n${content}`);
      setTimeout(()=>this.applying.delete(file.path),700);
    }
    this.pathToId.set(file.path,id);
    const title=parsed.title || file.basename;
    let changed=false;
    if(!existing || existing.title!==title) { await this.saveField(id,'title',title); changed=true; }
    if(!existing || existing.body!==parsed.body) { await this.saveField(id,'body',parsed.body); changed=true; }
    if(!existing || existing.folder!==folder) { await this.saveField(id,'folder',folder); changed=true; }
    if(!existing || existing.deleted) { await this.saveField(id,'deleted',false); changed=true; }
    if(changed) await this.saveField(id,'updatedAt',Date.now());
  }
  async sync() {
    if(this.busy || !this.key || !this.state.server || !this.state.token) return;
    this.busy=true;
    try {
      for(const file of this.app.vault.getMarkdownFiles().filter(f=>f.path.startsWith('Surge/'))) await this.fromFile(file);
      const pending=this.state.ops.filter(op=>op.localPending);
      const result=await exchange(this.state.server,this.state.token,this.state.cursor,pending.map(clean));
      pending.forEach(op=>op.localPending=false);
      const ids=new Set(this.state.ops.map(op=>op.id));
      this.state.ops.push(...result.ops.filter((op:Op)=>!ids.has(op.id)));
      this.state.cursor=result.cursor; await this.save();
      const material=await materialize(this.state.ops,this.key);
      this.notes=material.notes as Map<string,Note>; this.state.clock=Math.max(this.state.clock,material.maxClock);
      await this.toVault();
      new Notice('Surge 同步完成',2000);
    } catch(e:any) { new Notice(`Surge 同步失败：${e.message}`,5000); }
    finally { this.busy=false; }
  }
  async toVault() {
    const root=this.app.vault.getAbstractFileByPath('Surge');
    if(!root) await this.app.vault.createFolder('Surge');
    const existing=new Map<string,TFile>();
    for(const file of this.app.vault.getMarkdownFiles().filter(f=>f.path.startsWith('Surge/'))) {
      const id=parse(await this.app.vault.read(file)).id;
      if(id) { existing.set(id,file); this.pathToId.set(file.path,id); }
    }
    for(const note of this.notes.values()) {
      if(note.body==='surge-internal-category-record-v1') continue;
      const file=existing.get(note.id);
      if(note.deleted) { if(file) { this.applying.add(file.path); await this.app.vault.trash(file,true); setTimeout(()=>this.applying.delete(file.path),700); } continue; }
      const folder='Surge'+(note.folder?'/'+note.folder.split('/').map(safe).join('/'): '');
      await this.ensureFolder(folder);
      const target=`${folder}/${safe(note.title)}--${note.id}.md`;
      const value=render(note);
      if(file) {
        let path=file.path;
        if(path!==target && !this.app.vault.getAbstractFileByPath(target)) { const oldPath=path; this.applying.add(oldPath); this.applying.add(target); await this.app.fileManager.renameFile(file,target); setTimeout(()=>{ this.applying.delete(oldPath); this.applying.delete(target); },700); path=target; }
        if(await this.app.vault.read(file)!==value) { this.applying.add(path); await this.app.vault.modify(file,value); setTimeout(()=>this.applying.delete(path),700); }
        this.pathToId.set(path,note.id);
      } else if(!this.app.vault.getAbstractFileByPath(target)) { this.applying.add(target); await this.app.vault.create(target,value); this.pathToId.set(target,note.id); setTimeout(()=>this.applying.delete(target),700); }
    }
  }
  async ensureFolder(path:string) { const parts=path.split('/'); for(let i=1;i<=parts.length;i++){ const sub=parts.slice(0,i).join('/'); if(!this.app.vault.getAbstractFileByPath(sub)) await this.app.vault.createFolder(sub); } }
}

class SurgeSettings extends PluginSettingTab {
  constructor(app:App, private plugin:SurgePlugin) { super(app,plugin); }
  display() { const el=this.containerEl; el.empty(); el.createEl('h2',{text:'Surge 同步'});
    new Setting(el).setName('服务器地址').setDesc('请使用 HTTPS 地址').addText(t=>t.setPlaceholder('https://notes.example.com').setValue(this.plugin.state.server).onChange(async v=>{ this.plugin.state.server=v.trim().replace(/\/$/,''); await this.plugin.save(); }));
    new Setting(el).setName('访问令牌').setDesc('与 Docker 的 SURGE_TOKEN 相同，保存在本机插件数据中').addText(t=>{ t.inputEl.type='password'; t.setValue(this.plugin.state.token).onChange(async v=>{ this.plugin.state.token=v.trim(); await this.plugin.save(); }); });
    new Setting(el).setName('解锁').setDesc('口令仅保存在本次运行的内存中').addButton(b=>b.setButtonText('输入加密口令').onClick(()=>new PassphraseModal(this.app,v=>this.plugin.unlock(v)).open()));
  }
}
