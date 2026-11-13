import { catalog } from "@/lib/funding-server";
export async function GET(){try{return Response.json({data:await catalog()},{headers:{"Cache-Control":"no-store"}});}catch(e){return Response.json({error:String((e as Error).message)},{status:503,headers:{"Cache-Control":"no-store"}});}}
