const B='http://localhost:3001'
async function api(p,{method='GET',token,body}={}){const r=await fetch(B+p,{method,headers:{'content-type':'application/json','x-requested-with':'portfel',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json()}catch{};if(r.status>=400)console.log('ERR',method,p,r.status,JSON.stringify(j));return j}
const email=process.argv[2]||'qa@example.com'
let reg=await api('/api/auth/register',{method:'POST',body:{email,password:'password123'}})
if(!reg?.token) reg=await api('/api/auth/login',{method:'POST',body:{email,password:'password123'}})
const t=reg.token
if(process.argv[3]!=='empty'){
const P=[
 {name:'Вклад Надёжный',type:'Вклад',amount:500000,date:'2026-03-01',institution:'Сбербанк',rate:16,termEndDate:'2027-03-01',interestPayoutFrequency:'monthly'},
 {name:'Вклад Накопительный',type:'Вклад',amount:300000,date:'2026-05-10',institution:'ВТБ',rate:15.5,termEndDate:'2026-11-10'},
 {name:'ОФЗ 26238',type:'Облигация',amount:350000,date:'2025-12-01',institution:'Т-Инвестиции',ticker:'SU26238RMFS4',isin:'RU000A1038V6',quantity:500,averagePrice:700,currentPrice:620,nominal:1000,couponRate:7.1,maturityDate:'2026-10-20'},
 {name:'Сбербанк ао',type:'Акция',amount:280000,date:'2026-01-15',institution:'Т-Инвестиции',ticker:'SBER',quantity:1000,averagePrice:280,currentPrice:300},
 {name:'Газпром ао',type:'Акция',amount:150000,date:'2026-02-15',institution:'БКС',ticker:'GAZP',quantity:1000,averagePrice:150,currentPrice:128},
 {name:'ПИФ Облигации',type:'ПИФ',amount:120000,date:'2026-04-01',institution:'Альфа-Капитал'},
 {name:'Наличные USD',type:'Деньги',amount:5000,currency:'USD',date:'2026-06-01'},
 {name:'Золото',type:'Прочее',amount:90000,date:'2026-06-10'},
]
const ids=[]
for(const p of P){const r=await api('/api/positions',{method:'POST',token:t,body:p});ids.push(r?.id)}
await api('/api/transactions',{method:'POST',token:t,body:{type:'COUPON',amount:12400,date:'2026-07-20',positionId:ids[2],title:'Купон ОФЗ'}})
await api('/api/transactions',{method:'POST',token:t,body:{type:'DIVIDEND',amount:33000,date:'2026-07-25',positionId:ids[3],title:'Дивиденды SBER'}})
await api('/api/transactions',{method:'POST',token:t,body:{type:'BUY',amount:28000,date:'2026-08-01',positionId:ids[3],quantity:100,price:280,commission:50}})
await api('/api/payouts',{method:'POST',token:t,body:{title:'Купон ОФЗ 26238',amount:17750,date:'2026-10-20',type:'COUPON',positionId:ids[2]}})
await api('/api/payouts',{method:'POST',token:t,body:{title:'Старый купон',amount:1000,date:'2026-09-01',type:'COUPON'}})
for(let i=0;i<25;i++) await api('/api/transactions',{method:'POST',token:t,body:{type:'DEPOSIT',amount:1000+i,date:'2026-0'+(1+i%9)+'-1'+(i%9),title:'Пополнение '+i}})
}
console.log(JSON.stringify({token:t}))
