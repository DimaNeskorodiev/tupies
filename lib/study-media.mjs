import { ensure } from './store.mjs';

export const STUDY_MEDIA_LIMITS=Object.freeze({imageEdge:1568,imagePixels:1_150_000,imageBytes:3_500_000,inputPixels:40_000_000,audioBytes:24_000_000,chunkSeconds:60,sampleRate:16000});

/** Validate and fit inert image bytes. Call in the resource-limited source worker. */
export async function fitStudyImage(bytes){
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  ensure(png||jpeg||webp,415,'Visual study supports PNG, JPEG and WebP images.');
  const {default:sharp}=await import('sharp'),meta=await sharp(bytes,{limitInputPixels:STUDY_MEDIA_LIMITS.inputPixels}).metadata();
  ensure(meta.width&&meta.height,422,'The study image has no readable dimensions.');
  const turned=(meta.orientation||1)>=5,width=turned?meta.height:meta.width,height=turned?meta.width:meta.height,scale=Math.min(1,STUDY_MEDIA_LIMITS.imageEdge/Math.max(width,height),Math.sqrt(STUDY_MEDIA_LIMITS.imagePixels/(width*height))),size={width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
  const fitted=()=>sharp(bytes,{limitInputPixels:STUDY_MEDIA_LIMITS.inputPixels}).rotate().resize(size.width,size.height,{fit:'fill'});
  let output=png||meta.hasAlpha?await fitted().png({compressionLevel:9}).toBuffer():null,mediaType='image/png';
  if(!output||output.length>STUDY_MEDIA_LIMITS.imageBytes){output=await fitted().flatten({background:'#ffffff'}).jpeg({quality:85}).toBuffer();mediaType='image/jpeg';}
  ensure(output.length<=STUDY_MEDIA_LIMITS.imageBytes,413,'The fitted study image exceeds its byte limit.');return {mediaType,data:output.toString('base64'),...size,bytes:output.length};
}

/** Canvas is already an optional locked PDF dependency. An absent native module
 * is reported by the caller as unavailable; this never installs dependencies. */
export async function renderStudyPdfPage(bytes,pageNumber,maxPages=2000){
  const {getDocumentProxy,renderPageAsImage,createIsomorphicCanvasFactory}=await import('unpdf'),canvasImport=()=>import('@napi-rs/canvas'),CanvasFactory=await createIsomorphicCanvasFactory(canvasImport);
  const pdf=await getDocumentProxy(new Uint8Array(bytes),{CanvasFactory,isEvalSupported:false,maxImageSize:STUDY_MEDIA_LIMITS.inputPixels,disableFontFace:true,useSystemFonts:false,disableRange:true,disableStream:true});
  try{
    ensure(pdf.numPages<=maxPages&&Number.isInteger(pageNumber)&&pageNumber>=1&&pageNumber<=pdf.numPages,413,'The visual PDF page is outside the admitted page limits.');
    const page=await pdf.getPage(pageNumber),viewport=page.getViewport({scale:1}),{width,height}=viewport;ensure(Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0,422,'The PDF page dimensions are invalid.');
    const scale=Math.min(2,STUDY_MEDIA_LIMITS.imageEdge/Math.max(width,height),Math.sqrt(STUDY_MEDIA_LIMITS.imagePixels/(width*height))),image=await renderPageAsImage(pdf,pageNumber,{canvasImport,scale});
    return await fitStudyImage(Buffer.from(image));
  }finally{await pdf.loadingTask.destroy();}
}

/** Parse RIFF chunks without executing a decoder or trusting a filename. PCM16
 * mono/stereo is downmixed/resampled to the existing mono16k speech contract. */
export function parseStudyWav(input){
  const bytes=Buffer.isBuffer(input)?input:Buffer.from(input);ensure(bytes.length>=44&&bytes.length<=STUDY_MEDIA_LIMITS.audioBytes&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'&&bytes.readUInt32LE(4)===bytes.length-8,415,'Upload a bounded PCM16 RIFF/WAV source.');
  let offset=12,format,data,count=0;
  while(offset<bytes.length){ensure(++count<=128&&offset+8<=bytes.length,415,'The WAV chunk structure is invalid.');const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;ensure(end<=bytes.length,415,'The WAV chunk exceeds the source bytes.');
    if(name==='fmt '){ensure(!format&&size>=16&&size<=40,415,'The WAV format declaration is invalid.');format={encoding:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),blockAlign:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};}
    if(name==='data'){ensure(!data,415,'A WAV source must have one data chunk.');data={offset:start,size};}
    offset=end+(size%2);ensure(offset<=bytes.length,415,'The WAV padding is incomplete.');
  }
  ensure(format&&data&&format.encoding===1&&format.bits===16&&[1,2].includes(format.channels)&&format.sampleRate>=8000&&format.sampleRate<=96000&&format.blockAlign===format.channels*2&&format.byteRate===format.sampleRate*format.blockAlign&&data.size>0&&data.size%format.blockAlign===0,415,'Study audio requires PCM16 mono/stereo WAV at 8–96 kHz.');
  const frames=data.size/format.blockAlign;return {...format,dataOffset:data.offset,dataBytes:data.size,frames,durationSeconds:frames/format.sampleRate};
}
function wav(pcm){const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);}

/** Generate one valid <=60-second speech request at a time; raw audio is never
 * returned in metadata or persisted into the study manifest. */
export function* chunkStudyWav(input,{seconds=STUDY_MEDIA_LIMITS.chunkSeconds}={}){
  ensure(Number.isInteger(seconds)&&seconds>0&&seconds<=60,400,'Audio chunks must contain at most 60 seconds.');const bytes=Buffer.isBuffer(input)?input:Buffer.from(input),info=parseStudyWav(bytes),total=Math.max(1,Math.round(info.frames*16000/info.sampleRate)),chunkFrames=seconds*16000;
  const sample=frame=>{const offset=info.dataOffset+Math.min(info.frames-1,Math.max(0,frame))*info.blockAlign;return info.channels===1?bytes.readInt16LE(offset):(bytes.readInt16LE(offset)+bytes.readInt16LE(offset+2))/2;};
  for(let first=0;first<total;first+=chunkFrames){const count=Math.min(chunkFrames,total-first),pcm=Buffer.alloc(count*2);for(let index=0;index<count;index++){const position=(first+index)*info.sampleRate/16000,lower=Math.floor(position),fraction=position-lower,value=sample(lower)*(1-fraction)+sample(lower+1)*fraction;pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(value))),index*2);}yield {audioBase64:wav(pcm).toString('base64'),startSeconds:first/16000,endSeconds:Math.min(info.durationSeconds,(first+count)/16000),sampleRate:16000};}
}
