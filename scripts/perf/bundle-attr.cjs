const fs=require('fs'),path=require('path');
const {SourceMapConsumer}=require(process.cwd()+'/node_modules/source-map-js');
const dir=process.argv[2]; const file=process.argv[3];
const code=fs.readFileSync(path.join(dir,file),'utf8');
const map=JSON.parse(fs.readFileSync(path.join(dir,file+'.map'),'utf8'));
const smc=new SourceMapConsumer(map);
const lines=code.split('\n'); const lineStart=[0]; for(const l of lines) lineStart.push(lineStart[lineStart.length-1]+l.length+1);
const bytes={}; let prev=null;
const segs=[]; smc.eachMapping(m=>segs.push(m));
segs.sort((a,b)=>a.generatedLine-b.generatedLine||a.generatedColumn-b.generatedColumn);
for(let i=0;i<segs.length;i++){const s=segs[i],n=segs[i+1];
 const st=lineStart[s.generatedLine-1]+s.generatedColumn;
 const en=n&&n.generatedLine===s.generatedLine?lineStart[n.generatedLine-1]+n.generatedColumn:lineStart[s.generatedLine];
 const src=s.source||'(none)'; bytes[src]=(bytes[src]||0)+Math.max(0,en-st);}
const group=s=>{s=s.replace(/^.*node_modules\//,'nm:');if(s.startsWith('nm:')){const p=s.slice(3).split('/');return 'nm:'+(p[0].startsWith('@')?p[0]+'/'+p[1]:p[0]);}return s.replace(/^.*\/src\//,'src/');};
const agg={}; for(const[k,v]of Object.entries(bytes)){const g=group(k);agg[g]=(agg[g]||0)+v;}
const tot=Object.values(agg).reduce((a,b)=>a+b,0);
console.log('file',file,'attributed',tot,'of',code.length);
for(const[k,v]of Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0,40)) console.log(String(v).padStart(8),(100*v/code.length).toFixed(1).padStart(5)+'%',k);
