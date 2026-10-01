import { createPose } from './camera.js';

const canvas=document.getElementById('source'), ctx=canvas.getContext('2d'), video=document.getElementById('feed');
const status=document.getElementById('status'), tbody=document.getElementById('results');
let tick=0;
function paint(){
  tick+=.06; ctx.fillStyle='#75cbee';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#edce87';ctx.fillRect(0,500,1280,220);
  const x=640+Math.sin(tick)*80;ctx.strokeStyle='#173a58';ctx.lineWidth=28;ctx.lineCap='round';
  ctx.beginPath();ctx.arc(x,170,55,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(x,225);ctx.lineTo(x,440);ctx.moveTo(x,280);ctx.lineTo(x-130,360);ctx.moveTo(x,280);ctx.lineTo(x+130,350);ctx.moveTo(x,440);ctx.lineTo(x-90,610);ctx.moveTo(x,440);ctx.lineTo(x+90,610);ctx.stroke();requestAnimationFrame(paint);
}
async function run(){
  document.getElementById('run').disabled=true;tbody.textContent='';
  if(!video.srcObject){paint();video.srcObject=canvas.captureStream(60);await video.play();}
  for(const delegate of ['CPU','GPU']) for(const model of ['lite','full']){
    const label=`${delegate.toLowerCase()}-${model}`;status.textContent=`${label} 모델 준비 중…`;
    const pose=await createPose(model,delegate);let detected=0;const samples=[];
    for(let i=0;i<90;i++){
      await new Promise(requestAnimationFrame);const begin=performance.now();
      const result=pose.detectForVideo(video,begin);samples.push(performance.now()-begin);detected+=result.landmarks.length;
    }
    pose.close();const total=samples.reduce((a,b)=>a+b,0), fps=1000/(total/samples.length);
    const row=document.createElement('tr');row.innerHTML=`<td>${label}</td><td>${fps.toFixed(1)}</td><td>${(total/samples.length).toFixed(2)}</td><td>${detected}</td>`;tbody.appendChild(row);
  }
  status.textContent='완료 — 결과를 PERFORMANCE.md에 기록하세요.';document.getElementById('run').disabled=false;
}
document.getElementById('run').addEventListener('click',()=>run().catch(e=>{console.error(e);status.textContent='오류: '+e.message;}));
if(new URLSearchParams(location.search).has('auto')) run().catch(console.error);
