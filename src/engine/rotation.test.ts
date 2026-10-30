import * as mupdf from 'mupdf';
import { describe, expect, it } from 'vitest';
import { runExport } from './exporter';
import { maskContains, toViewRect } from '../model/geometry';
import type { ExportMask, ExportOptions } from './protocol';

const options: ExportOptions = { mode: 'separate', mergedName: 'out.pdf', rasterize: false, keepText: false, rasterDpi: 150, flatten: true, stripMetadata: true, stripExtras: true, stripOutlines: false, props: null, encryption: null };
function fixture() {
  const d = new mupdf.PDFDocument();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0,0,200,200], false);
  const data = pix.getPixels();
  for (let y=0;y<200;y++) for (let x=0;x<200;x++) { const i=y*pix.getStride()+x*3; data[i]=100+(x%20<10?60:0); data[i+1]=120; data[i+2]=160; }
  const image = new mupdf.Image(pix); const ref = d.addImage(image); image.destroy(); pix.destroy();
  const res = d.addObject({XObject:{Im0:ref},Font:{F1:d.addSimpleFont(new mupdf.Font('Helvetica'))}});
  d.insertPage(-1, d.addPage([0,0,200,200], 0, res, 'q 200 0 0 200 0 0 cm /Im0 Do Q 0 0 0 RG 3 w 5 100 m 195 100 l S 1 0 0 rg 95 95 10 10 re f BT /F1 12 Tf 75 100 Td (SECRET) Tj ET BT /F1 12 Tf 8 180 Td (PUBLIC) Tj ET'));
  const b=d.saveToBuffer('garbage=4,compress=yes');const result=b.asUint8Array().slice();b.destroy();d.destroy();return result;
}
const src=fixture();
function snapshot(bytes: Uint8Array) {
 const doc=new mupdf.PDFDocument(bytes), p=doc.loadPage(0), pix=p.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false,true);
 const result={pixels:pix.getPixels().slice(),stride:pix.getStride(), text:p.toStructuredText('preserve-whitespace').asText()};pix.destroy();p.destroy();doc.destroy();return result;
}
function withoutOverlay(bytes: Uint8Array) {
 const d=new mupdf.PDFDocument(bytes), content=d.findPage(0).get('Contents');
 expect(content.isArray()).toBe(true);
 content.delete(content.length-1);
 const p=d.loadPage(0), pix=p.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false,true);
 const result={pixels:pix.getPixels().slice(),stride:pix.getStride()};pix.destroy();p.destroy();d.destroy();return result;
}
describe('回転した範囲の書き出し',()=>{
 for (const style of ['fill','mosaic','blur'] as const) it(`${style}は傾いた位置を隠し、その外を残す`,async()=>{
   const mask:ExportMask={id:'rot',page:0,x:45,y:75,w:130,h:50,angle:25,style,strength:10,color:'#000000',opacity:1,label:null};
   const out=await runExport(mupdf,{docs:[{docId:'doc',name:'out.pdf',order:[0],rot:{},masks:[mask]}],options},()=>({bytes:src}),()=>{});
   const file=out.files[0],original=snapshot(src),actual=snapshot(file.bytes);
   expect(actual.text).not.toContain('SECRET'); expect(actual.text).toContain('PUBLIC');
   const at=(x:number,y:number)=>(y*actual.stride+x*3);
   expect([...actual.pixels.slice(at(44,48),at(44,48)+3)]).toEqual([...original.pixels.slice(at(44,48),at(44,48)+3)]);
   // マスクを横切る長い図形は削除されるが、枠外の見た目は保たれる。
   expect([...actual.pixels.slice(at(10,100),at(10,100)+3)]).toEqual([...original.pixels.slice(at(10,100),at(10,100)+3)]);
   expect([...actual.pixels.slice(at(100,100),at(100,100)+3)]).not.toEqual([...original.pixels.slice(at(100,100),at(100,100)+3)]);
   expect(file.report.leakedChars).toBe(0);
   expect(file.report.passed).toBe(true);
   const underlying=withoutOverlay(file.bytes);
   // 描画を取り除いてもマスク内部の元画像が残っていない（辺から余裕を取って確認）。
   let tested=0;
   const inner={...mask,x:mask.x+3,y:mask.y+3,w:mask.w-6,h:mask.h-6};
   for(let y=20;y<180;y+=3) for(let x=20;x<180;x+=3) if(maskContains(inner,x+.5,y+.5)) {
     const i=y*underlying.stride+x*3; expect([...underlying.pixels.slice(i,i+3)]).toEqual([255,255,255]); tested++;
   }
   expect(tested).toBeGreaterThan(100);
   // 表示の背景として入れる画像そのものにも、元のマスク内部を残さない。
   const pdf=new mupdf.PDFDocument(file.bytes), ref=pdf.findPage(0).getInheritable('Resources').get('XObject').get('KakusuBackdrop0');
   expect(ref.isNull()).toBe(false);
   const img=pdf.loadImage(ref), safe=img.toPixmap(), i=300*safe.getStride()+300*3;
   expect([...safe.getPixels().slice(i,i+3)]).toEqual([255,255,255]);safe.destroy();img.destroy();pdf.destroy();
 },30000);
 it('ページ自体が90度回転しても、マスク内の文字と元画像を消す',async()=>{
   const mask:ExportMask={id:'rot',page:0,x:45,y:75,w:130,h:50,angle:-25,style:'fill',strength:10,color:'#000000',opacity:1,label:null};
   const out=await runExport(mupdf,{docs:[{docId:'doc',name:'out.pdf',order:[0],rot:{0:90},masks:[mask]}],options},()=>({bytes:src}),()=>{});
   const file=out.files[0], actual=snapshot(file.bytes);
   expect(actual.text).not.toContain('SECRET'); expect(actual.text).toContain('PUBLIC'); expect(file.report.leakedChars).toBe(0); expect(file.report.passed).toBe(true);
   const doc=new mupdf.PDFDocument(file.bytes), content=doc.findPage(0).get('Contents');content.delete(content.length-1);
   const p=doc.loadPage(0),pix=p.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false,true),data=pix.getPixels();
   const view={...toViewRect(mask,90,200,200),angle:mask.angle};
   const inner={...view,x:view.x+3,y:view.y+3,w:view.w-6,h:view.h-6};let tested=0;
   for(let y=10;y<190;y+=3) for(let x=10;x<190;x+=3) if(maskContains(inner,x+.5,y+.5)) {
     const i=y*pix.getStride()+x*3;expect([...data.slice(i,i+3)]).toEqual([255,255,255]);tested++;
   }
   expect(tested).toBeGreaterThan(100);pix.destroy();p.destroy();doc.destroy();
 },30000);
 for(const angle of [-155,-89,-45,-5,5,45,89,155]) it(`${angle}度でも内部に元画像を残さない`,async()=>{
   const mask:ExportMask={id:'rot',page:0,x:30,y:75,w:140,h:50,angle,style:'fill',strength:10,color:'#000000',opacity:1,label:null};
   const out=await runExport(mupdf,{docs:[{docId:'doc',name:'out.pdf',order:[0],rot:{},masks:[mask]}],options},()=>({bytes:src}),()=>{});
   const underlying=withoutOverlay(out.files[0].bytes);let tested=0;
   for(let y=0;y<200;y++) for(let x=0;x<200;x++) if(maskContains(mask,x+.5,y+.5)) {
     const i=y*underlying.stride+x*3;expect([...underlying.pixels.slice(i,i+3)]).toEqual([255,255,255]);tested++;
   }
   expect(tested).toBeGreaterThan(6000);
 },30000);
 it('見た目だけ重ねるモードは、元の文字を意図どおり残す',async()=>{
   const mask:ExportMask={id:'rot',page:0,x:45,y:75,w:130,h:50,angle:25,style:'fill',strength:10,color:'#000000',opacity:1,label:null};
   const out=await runExport(mupdf,{docs:[{docId:'doc',name:'out.pdf',order:[0],rot:{},masks:[mask]}],options:{...options,keepText:true}},()=>({bytes:src}),()=>{});
   expect(snapshot(out.files[0].bytes).text).toContain('SECRET');
   expect(out.files[0].report.textKept).toBe(true);
 });
 for (const rot of [90,180,270] as const) it(`もともと${rot}度回転したPDFでも内容を消す`,async()=>{
   const d=new mupdf.PDFDocument(src);d.findPage(0).put('Rotate',rot);
   const b=d.saveToBuffer('garbage=4,compress=yes'), rotated=b.asUint8Array().slice();b.destroy();d.destroy();
   const base:ExportMask={id:'rot',page:0,x:45,y:75,w:130,h:50,angle:25,style:'fill',strength:10,color:'#000000',opacity:1,label:null};
   const mask={...base,...toViewRect(base,rot,200,200)};
   const out=await runExport(mupdf,{docs:[{docId:'doc',name:'out.pdf',order:[0],rot:{},masks:[mask]}],options},()=>({bytes:rotated}),()=>{});
   const file=out.files[0];expect(snapshot(file.bytes).text).not.toContain('SECRET');expect(file.report.leakedChars).toBe(0);
   const underlying=withoutOverlay(file.bytes);let tested=0;
   const inner={...mask,x:mask.x+3,y:mask.y+3,w:mask.w-6,h:mask.h-6};
   for(let y=10;y<190;y+=3) for(let x=10;x<190;x+=3) if(maskContains(inner,x+.5,y+.5)) {
     const i=y*underlying.stride+x*3;expect([...underlying.pixels.slice(i,i+3)]).toEqual([255,255,255]);tested++;
   }
   expect(tested).toBeGreaterThan(100);
 },30000);
});
