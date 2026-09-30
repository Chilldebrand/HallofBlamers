export function isAccessError(error:unknown){
 const e=error as {code?:string;status?:number}|null;
 return !!e&&(e.code==='42501'||e.code==='PGRST301'||e.code==='PGRST303'||e.status===401||e.status===403);
}
