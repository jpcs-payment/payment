import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const [file]=process.argv.slice(2)
if(!file){console.error('Usage: node scripts/provision-users.js members.json');process.exit(1)}
if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY){console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the server environment.');process.exit(1)}
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}})
const rows=JSON.parse(await readFile(file,'utf8'))
if(!Array.isArray(rows))throw new Error('Input must be a JSON array.')
for(const row of rows){
  if(!row.email||!row.full_name||!['member','treasurer','auditor','admin'].includes(row.role||'member'))throw new Error(`Invalid account row: ${JSON.stringify(row)}`)
  const {data,error}=await admin.auth.admin.createUser({email:row.email,password:row.password||'JPCS2026',email_confirm:true,user_metadata:{full_name:row.full_name}})
  if(error)throw new Error(`${row.email}: ${error.message}`)
  const {error:profileError}=await admin.from('profiles').insert({id:data.user.id,email:row.email,full_name:row.full_name,student_number:row.student_number||null,year_level:row.year_level||null,role:row.role||'member',must_change_password:true})
  if(profileError){await admin.auth.admin.deleteUser(data.user.id);throw new Error(`${row.email}: profile creation failed: ${profileError.message}`)}
  console.log(`Provisioned ${row.role||'member'}: ${row.email}`)
}
