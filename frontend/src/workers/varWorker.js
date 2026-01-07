/* eslint-disable no-restricted-globals */
function zFromConf(conf){
  if (Math.abs(conf-0.95) < 1e-6) return 1.645;
  if (Math.abs(conf-0.99) < 1e-6) return 2.33;
  // Moro approximation (和你 Python 版一致)
  const a=[2.50662823884,-18.61500062529,41.39119773534,-25.44106049637];
  const b=[-8.47351093090,23.08336743743,-21.06224101826,3.13082909833];
  const c=[0.3374754822726147,0.9761690190917186,0.1607979714918209,
           0.0276438810333863,0.0038405729373609,0.0003951896511919,
           0.0000321767881768,0.0000002888167364,0.0000003960315187];
  const y=conf-0.5;
  if (Math.abs(y)<0.42){
    const r=y*y;
    const num=y*(((a[3]*r+a[2])*r+a[1])*r+a[0]);
    const den=((((b[3]*r+b[2])*r+b[1])*r+b[0])*r+1.0);
    return num/den;
  }
  let r = y<=0? conf : 1-conf;
  r = Math.log(-Math.log(r));
  let x=c[0];
  for(let i=1;i<c.length;i++) x += c[i]*Math.pow(r,i);
  return y>0? x : -x;
}

function mean(arr){
  let s=0; for(const v of arr) s+=v; return s/arr.length;
}
function std(arr){
  const m=mean(arr);
  let s=0; for(const v of arr){ const d=v-m; s+=d*d; }
  return Math.sqrt(s/(arr.length-1));
}

// 简单 t df 拟合（你的网格 MLE）
function studentTLoglike(x, df){
  // 用近似 lgamma
  function lgamma(z){
    // Lanczos approx
    const g=7;
    const p=[0.99999999999980993,676.5203681218851,-1259.1392167224028,
      771.32342877765313,-176.61502916214059,12.507343278686905,
      -0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
    if(z<0.5) return Math.log(Math.PI)-Math.log(Math.sin(Math.PI*z))-lgamma(1-z);
    z-=1;
    let x0=p[0];
    for(let i=1;i<p.length;i++) x0+=p[i]/(z+i);
    const t=z+g+0.5;
    return 0.5*Math.log(2*Math.PI)+(z+0.5)*Math.log(t)-t+Math.log(x0);
  }
  const a = lgamma((df+1)/2) - lgamma(df/2) - 0.5*Math.log(df*Math.PI);
  let sum=0;
  for(const v of x){
    sum += a - (df+1)/2 * Math.log(1+(v*v)/df);
  }
  return sum;
}
function fitTDfMLE(r, dfMin=3, dfMax=60){
  const mu=mean(r), sigma=std(r);
  if(sigma<=0) return 5;
  const x=r.map(v=>(v-mu)/sigma);
  let bestDf=dfMin, bestLL=-1e100;
  for(let df=dfMin; df<=dfMax; df++){
    const ll=studentTLoglike(x, df);
    if(ll>bestLL){ bestLL=ll; bestDf=df; }
  }
  return bestDf;
}

// 随机
function randn(){
  // Box-Muller
  let u=0,v=0;
  while(u===0)u=Math.random();
  while(v===0)v=Math.random();
  return Math.sqrt(-2.0*Math.log(u))*Math.cos(2.0*Math.PI*v);
}
// Marsaglia-Tsang Gamma sampler
function randGamma(k){
  if (k < 1){
    // boost for k<1
    const u = Math.random();
    return randGamma(1+k) * Math.pow(u, 1/k);
  }
  const d = k - 1/3;
  const c = 1/Math.sqrt(9*d);
  while (true){
    let x = randn();
    let v = 1 + c*x;
    if (v <= 0) continue;
    v = v*v*v;
    const u = Math.random();
    if (u < 1 - 0.0331*(x*x)*(x*x)) return d*v;
    if (Math.log(u) < 0.5*x*x + d*(1 - v + Math.log(v))) return d*v;
  }
}

function randChiSquare(df){
  // Chi-square(df) = 2*Gamma(df/2)
  return 2 * randGamma(df/2);
}

function randStdT(df){
  const z = randn();
  const chi2 = randChiSquare(df);
  return z / Math.sqrt(chi2/df);
}


// quantile
function quantile(arr, q){
  const a=[...arr].sort((x,y)=>x-y);
  const pos=(a.length-1)*q;
  const base=Math.floor(pos);
  const rest=pos-base;
  if(a[base+1]!==undefined) return a[base]+rest*(a[base+1]-a[base]);
  return a[base];
}

self.onmessage = (e)=>{
  const { task, payload } = e.data;

  if(task==="mcSingle"){
    const { r, conf, T, sims, method, dfMax } = payload;
    const ztail=1-conf;

    if(r.length<2){
      self.postMessage({ok:true, var:NaN});
      return;
    }

    const mu=mean(r), sigma=std(r);

    if(method==="normal"){
      const Rs=new Float64Array(sims);
      for(let k=0;k<sims;k++){
        let sum=0;
        for(let t=0;t<T;t++) sum += mu + sigma*randn();
        Rs[k]=sum;
      }
      const v = -quantile(Rs, ztail);
      self.postMessage({ok:true, var:v, mu, sigma});
      return;
    }

    if(method==="t_mc"){
      const dfHat=fitTDfMLE(r,3,dfMax);
      const scale = dfHat>2 ? sigma*Math.sqrt((dfHat-2)/dfHat) : sigma;
      const Rs=new Float64Array(sims);
      for(let k=0;k<sims;k++){
        let sum=0;
        for(let t=0;t<T;t++) sum += mu + scale*randStdT(dfHat);
        Rs[k]=sum;
      }
      const v = -quantile(Rs, ztail);
      self.postMessage({ok:true, var:v, mu, sigma, nu: dfHat, z: zFromConf(conf)});
      return;
    }

    if(method==="bootstrap"){
      const Rs=new Float64Array(sims);
      for(let k=0;k<sims;k++){
        let sum=0;
        for(let t=0;t<T;t++){
          const idx=(Math.random()*r.length)|0;
          sum += r[idx];
        }
        Rs[k]=sum;
      }
      const v=-quantile(Rs, ztail);
      self.postMessage({ok:true, var:v});
      return;
    }
  }
}
