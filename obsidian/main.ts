import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { deriveKey, materialize, fetchInfo, exchange, downloadBlob, decryptValue, urlToBytes } from '../web/core.mjs';
import { planSync, planAttachments, attachmentIds, attachmentPath, extensionFor, isInside, isManagedAttachment, normalizeOutputFolder } from './sync-plan.mjs';

type Op = { id:string; noteId:string; field:string; clock:number; actor:string; ciphertext:string; localPending?:boolean };
type Note = { id:string; title:string; body:string; folder:string; kind?:string; deleted:boolean; purged?:boolean };
type State = { server:string; token:string; salt:string; actor:string; clock:number; cursor:number; ops:Op[]; folder:string; managedFolders:string[] };
type Asset = { path:string; bytes:Uint8Array };
const initial = ():State => ({ server:'', token:'', salt:'', actor:crypto.randomUUID(), clock:0, cursor:0, ops:[], folder:'Surge', managedFolders:['Surge'] });
const surgeId = (text:string, path:string):string|null => {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return frontmatter?.match(/^surge-id:\s*([a-f0-9-]{36})\s*$/m)?.[1] || path.match(/--([a-f0-9-]{36})\.md$/)?.[1] || null;
};

class PassphraseModal extends Modal {
  constructor(app:App, private onSubmit:(value:string)=>void) { super(app); }
  onOpen() { this.titleEl.setText('解锁 Surge'); const input = this.contentEl.createEl('input', { type:'password', placeholder:'加密口令' }); input.style.width='100%'; const button = this.contentEl.createEl('button', { text:'解锁并同步' }); button.onclick=()=>{ const value=input.value; this.close(); this.onSubmit(value); }; input.onkeydown=e=>{ if(e.key==='Enter') button.click(); }; input.focus(); }
  onClose() { this.contentEl.empty(); }
}

export default class SurgePlugin extends Plugin {
  state:State = initial(); key:CryptoKey|null = null; busy = false; blobCache = new Map<string,{ bytes:Uint8Array; extension:string }|null>();
  async onload() {
    this.state = Object.assign(initial(), await this.loadData() || {});
    this.state.folder=normalizeOutputFolder(this.state.folder || 'Surge');
    const roots=['Surge', ...(Array.isArray(this.state.managedFolders)?this.state.managedFolders:[]), this.state.folder];
    this.state.managedFolders=[...new Set(roots.flatMap(root=>{ try { return [normalizeOutputFolder(root)]; } catch { return []; } }))];
    // Older versions produced local edits. Never upload an unsent local operation.
    const retained = this.state.ops.filter(op=>!op.localPending);
    if(retained.length !== this.state.ops.length) { this.state.ops = retained; await this.save(); }
    this.addSettingTab(new SurgeSettings(this.app, this));
    this.addCommand({ id:'unlock-sync', name:'解锁并同步', callback:()=>new PassphraseModal(this.app, value=>this.unlock(value)).open() });
    this.addRibbonIcon('refresh-cw', '从 Surge 同步', ()=>this.sync());
    this.registerInterval(window.setInterval(()=>this.sync(),30000));
  }
  async save() { await this.saveData(this.state); }
  async setFolder(value:string) {
    const folder=normalizeOutputFolder(value);
    if(folder===this.state.folder) return;
    this.state.managedFolders=[...new Set([...this.state.managedFolders,this.state.folder,folder])];
    this.state.folder=folder;
    await this.save();
    if(this.key) await this.sync();
    else new Notice('同步位置已保存；解锁后迁移已有笔记');
  }
  async unlock(passphrase:string) {
    try {
      if(!this.state.server || !this.state.token) throw new Error('请先设置服务器地址和访问令牌');
      const salt=(await fetchInfo(this.state.server)).salt;
      if(this.state.salt && salt!==this.state.salt) throw new Error('服务器与本地同步记录不匹配');
      const key=await deriveKey(passphrase,salt);
      // Validate cached ciphertext before accepting the key or touching the vault.
      await materialize(this.state.ops,key);
      this.state.salt=salt; this.key=key; this.blobCache.clear(); await this.save();
      await this.sync();
    } catch(e:any) { this.key=null; new Notice(e.name==='OperationError'?'Surge 加密口令错误':`Surge: ${e.message}`); }
  }
  async sync() {
    if(this.busy || !this.key || !this.state.server || !this.state.token) return;
    this.busy=true;
    try {
      // Download first; a failed request must never delete local notes from stale cache.
      const result=await exchange(this.state.server,this.state.token,this.state.cursor,[]);
      const ids=new Set(this.state.ops.map(op=>op.id));
      const ops=[...this.state.ops, ...result.ops.filter((op:Op)=>!ids.has(op.id))];
      const material=await materialize(ops,this.key);
      await this.toVault(material.notes as Map<string,Note>);
      const purged=new Set([...material.notes.values()].filter((note:Note)=>note.purged).map((note:Note)=>note.id));
      this.state.ops=ops.filter(op=>!purged.has(op.noteId)||op.field==='purged');
      this.state.cursor=result.cursor;
      this.state.clock=Math.max(this.state.clock,material.maxClock);
      await this.save();
      new Notice('Surge 同步完成',2000);
    } catch(e:any) {
      if(e.name==='OperationError') this.key=null;
      new Notice(e.name==='OperationError'?'Surge 加密口令错误':`Surge 同步失败：${e.message}`,5000);
    }
    finally { this.busy=false; }
  }
  async toVault(notes:Map<string,Note>) {
    const roots=this.state.managedFolders;
    const assets=new Map<string,Asset>();
    const referenced=attachmentIds(notes.values());
    for(const id of referenced) {
      if(!this.blobCache.has(id)) {
        const payload=await decryptValue(this.key!,await downloadBlob(this.state.server,this.state.token,id));
        if(payload?.kind==='password') { this.blobCache.set(id,null); continue; }
        if(typeof payload?.data!=='string') throw new Error(`附件数据无效：${id}`);
        this.blobCache.set(id,{ bytes:urlToBytes(payload.data), extension:extensionFor(payload) });
      }
      const cached=this.blobCache.get(id);
      if(!cached) continue;
      assets.set(id,{ path:attachmentPath(this.state.folder,id,cached.extension), bytes:cached.bytes });
    }
    const allFiles=this.app.vault.getFiles();
    const files=await Promise.all(allFiles.filter(file=>file.extension==='md' && roots.some(root=>isInside(file.path,root)) && !roots.some(root=>isInside(file.path,`${root}/_attachments`) && isManagedAttachment(file.path))).map(async file=>{ const content=await this.app.vault.read(file); return { path:file.path, id:surgeId(content,file.path), content }; }));
    const assetFiles=await Promise.all(allFiles.filter(file=>roots.some(root=>isInside(file.path,`${root}/_attachments`)) && isManagedAttachment(file.path)).map(async file=>({ path:file.path, bytes:new Uint8Array(await this.app.vault.readBinary(file)) })));
    const plan=planSync(notes.values(),files,this.state.folder,assets);
    const assetPlan=planAttachments(assets,assetFiles);
    for(const asset of [...assetPlan.creates,...assetPlan.writes]) {
      await this.ensureFolder(asset.path.slice(0,asset.path.lastIndexOf('/')));
      const file=this.app.vault.getAbstractFileByPath(asset.path);
      const bytes=asset.bytes.slice().buffer;
      if(file instanceof TFile) await this.app.vault.modifyBinary(file,bytes);
      else if(!file) await this.app.vault.createBinary(asset.path,bytes);
      else throw new Error(`附件路径已被目录占用：${asset.path}`);
    }
    for(const path of plan.removes) {
      const file=this.app.vault.getAbstractFileByPath(path);
      if(file instanceof TFile) await this.app.vault.delete(file);
    }
    const staged:{ file:TFile; to:string }[]=[];
    let temporaryNumber=0;
    for(const move of plan.moves) {
      const file=this.app.vault.getAbstractFileByPath(move.from);
      if(!(file instanceof TFile)) throw new Error(`同步文件已消失：${move.from}`);
      const parent=move.from.slice(0,move.from.lastIndexOf('/'));
      let temporary:string;
      do { temporary=`${parent}/Surge 临时同步 ${++temporaryNumber}.md`; } while(this.app.vault.getAbstractFileByPath(temporary));
      await this.app.fileManager.renameFile(file,temporary);
      staged.push({ file, to:move.to });
    }
    for(const move of staged) {
      await this.ensureFolder(move.to.slice(0,move.to.lastIndexOf('/')));
      await this.app.fileManager.renameFile(move.file,move.to);
    }
    for(const write of plan.writes) {
      const file=this.app.vault.getAbstractFileByPath(write.path);
      if(!(file instanceof TFile)) throw new Error(`同步文件已消失：${write.path}`);
      await this.app.vault.modify(file,write.content);
    }
    for(const create of plan.creates) {
      await this.ensureFolder(create.path.slice(0,create.path.lastIndexOf('/')));
      await this.app.vault.create(create.path,create.content);
    }
    for(const path of assetPlan.removes) {
      const file=this.app.vault.getAbstractFileByPath(path);
      if(file instanceof TFile) await this.app.vault.delete(file);
    }
    for(const id of this.blobCache.keys()) if(!referenced.has(id)) this.blobCache.delete(id);
  }
  async ensureFolder(path:string) { const parts=path.split('/'); for(let i=1;i<=parts.length;i++){ const sub=parts.slice(0,i).join('/'); if(!this.app.vault.getAbstractFileByPath(sub)) await this.app.vault.createFolder(sub); } }
}

class SurgeSettings extends PluginSettingTab {
  constructor(app:App, private plugin:SurgePlugin) { super(app,plugin); }
  display() { const el=this.containerEl; el.empty(); el.createEl('h2',{text:'Surge 单向同步'});
    new Setting(el).setName('服务器地址').setDesc('请使用 HTTPS 地址').addText(t=>t.setPlaceholder('https://notes.example.com').setValue(this.plugin.state.server).onChange(async v=>{ this.plugin.state.server=v.trim().replace(/\/$/,''); this.plugin.key=null; this.plugin.blobCache.clear(); await this.plugin.save(); }));
    new Setting(el).setName('访问令牌').setDesc('与 Docker 的 SURGE_TOKEN 相同，保存在本机插件数据中').addText(t=>{ t.inputEl.type='password'; t.setValue(this.plugin.state.token).onChange(async v=>{ this.plugin.state.token=v.trim(); this.plugin.key=null; this.plugin.blobCache.clear(); await this.plugin.save(); }); });
    let folderValue=this.plugin.state.folder;
    new Setting(el).setName('笔记保存位置').setDesc('库内文件夹路径，例如：资料/Surge。保存后迁移已有同步笔记。').addText(t=>t.setValue(folderValue).onChange(v=>{ folderValue=v; })).addButton(b=>b.setButtonText('保存并迁移').onClick(async()=>{ try { await this.plugin.setFolder(folderValue); } catch(e:any) { new Notice(`Surge: ${e.message}`,5000); } }));
    new Setting(el).setName('解锁').setDesc('只同步普通笔记，不同步待办和思维导图；图片和文件放在所选目录的 _attachments/ 中。源端删除会移除对应笔记和无引用附件。').addButton(b=>b.setButtonText('输入加密口令').onClick(()=>new PassphraseModal(this.app,v=>this.plugin.unlock(v)).open()));
  }
}
