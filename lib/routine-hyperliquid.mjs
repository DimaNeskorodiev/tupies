// Public Hyperliquid Info reads with literal wallet and vault identifiers.
// They go through the ordinary Web capability, destination and approval checks.
import { ensure } from './store.mjs';

const endpoint='https://api.hyperliquid.xyz/info';
const address=/^0x[0-9a-f]{40}$/i;
const precision=10n**18n;
const isAddress=value=>typeof value==='string' && address.test(value);

export function validateVaultReportTarget({vault,wallets}) {
  ensure(isAddress(vault) && Array.isArray(wallets) && wallets.length>=1 && wallets.length<=4 &&
    Array.from(wallets).every(isAddress),400,'Supply one Hyperliquid vault and 1–4 fixed public wallet addresses.');
  const normalized=wallets.map(wallet=>wallet.toLowerCase());
  ensure(new Set(normalized).size===normalized.length && !normalized.includes(vault.toLowerCase()),
    400,'Hyperliquid wallet addresses must be distinct from one another and the vault.');
  return {vault:vault.toLowerCase(),wallets:normalized};
}

function amount(value) {
  const parts=typeof value==='string' && /^(-?)([0-9]{1,18})(?:\.([0-9]{1,18}))?$/.exec(value);
  ensure(parts,502,'Hyperliquid did not provide a valid amount for the configured wallet.');
  const [,sign,whole,fraction='']=parts;
  return (BigInt(whole)*precision+BigInt(fraction.padEnd(18,'0')))*(sign?-1n:1n);
}

function display(value) {
  const magnitude=value<0n?-value:value;
  const cents=(magnitude+5n*10n**15n)/10n**16n;
  return `${value<0n && cents>0n?'-':''}${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
}

export async function hyperliquidVaultReport({vault,wallets},{callTool,signal}) {
  const positions=[];
  for(const wallet of wallets) {
    signal?.throwIfAborted();
    const response=await callTool('http_fetch',{
      url:endpoint,method:'POST',followRedirects:false,body:{type:'vaultDetails',vaultAddress:vault,user:wallet},
    },{signal});
    signal?.throwIfAborted();
    ensure(response?.status===200 && response.url===endpoint && typeof response.text==='string' &&
      !response.extraction?.limited && !response.error,502,'Hyperliquid did not return a complete vault response.');
    let data;
    try {data=JSON.parse(response.text);} catch {ensure(false,502,'Hyperliquid did not return valid vault JSON.');}
    const position=data?.followerState;
    ensure(isAddress(data?.vaultAddress) && data.vaultAddress.toLowerCase()===vault &&
      isAddress(position?.user) && position.user.toLowerCase()===wallet,
      502,'Hyperliquid did not confirm the configured wallet’s position in this vault.');
    const equity=amount(position.vaultEquity),pnl=amount(position.pnl),allTimePnl=amount(position.allTimePnl);
    ensure(equity>=0n,502,'Hyperliquid returned a negative equity for the configured wallet.');
    positions.push({wallet,equity,pnl,allTimePnl});
  }
  const total=key=>display(positions.reduce((sum,row)=>sum+row[key],0n));
  return {
    observedAt:new Date().toISOString(),
    positions:positions.map(({wallet,equity,pnl,allTimePnl})=>({
      wallet:`${wallet.slice(0,8)}…${wallet.slice(-6)}`,equity:display(equity),pnl:display(pnl),allTimePnl:display(allTimePnl),
    })),
    total:{equity:total('equity'),pnl:total('pnl'),allTimePnl:total('allTimePnl')},
  };
}
