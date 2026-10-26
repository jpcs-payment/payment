import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
import QRCode from 'npm:qrcode@1.5.4'

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
}
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}})
const htmlEscapes:Record<string,string>={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}
const escapeHtml=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>htmlEscapes[c]||c)
const first=(value:any)=>Array.isArray(value)?value[0]:value
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabaseUrl=Deno.env.get('SUPABASE_URL')!
const anonKey=Deno.env.get('SUPABASE_ANON_KEY')||Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!
const appOrigin=Deno.env.get('APP_ORIGIN')||''
const normalizeOrigin=(value:string|null)=>{
  try{const url=new URL(value||'');return url.protocol==='http:'||url.protocol==='https:'?url.origin:''}catch{return ''}
}
const configuredAppOrigin=normalizeOrigin(appOrigin)
const isLocalOrigin=(origin:string)=>/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
const resolveAppOrigin=(requestOrigin:string)=>{
  // Prefer the origin the officer is actually using. If they are on localhost,
  // fall back to APP_ORIGIN so QR codes can point at a LAN or deployed URL.
  if(requestOrigin&&!isLocalOrigin(requestOrigin))return requestOrigin
  return configuredAppOrigin||requestOrigin||'https://example.invalid'
}

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  if(req.method!=='POST')return response({error:'Method not allowed.'},405)
  try{
    const authorization=req.headers.get('Authorization')||''
    const resolvedOrigin=resolveAppOrigin(normalizeOrigin(req.headers.get('Origin')))
    const {action,params={},input={},sessionAccessToken}=await req.json()
    const headerToken=authorization.replace(/^Bearer\s+/i,'')
    const sessionToken=sessionAccessToken||input.sessionAccessToken||''
    const admin=createClient(supabaseUrl,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}})

    if(action==='emails.dispatch'){
      if(headerToken!==serviceKey)return response({error:'Service authorization required.'},403)
      const result=await dispatchOutbox(admin,resolvedOrigin)
      return response(result)
    }
    const authClient=createClient(supabaseUrl,anonKey,{auth:{autoRefreshToken:false,persistSession:false}})
    const tokens=[...new Set([headerToken,sessionToken].filter(Boolean))]
    if(!tokens.length)return response({error:'Authentication required.'},401)
    let user=null,userError=null
    for(const accessToken of tokens){const result=await authClient.auth.getUser(accessToken);user=result.data.user;userError=result.error;if(user)break}
    if(userError||!user){console.warn('Edge Function token validation failed:',userError?.message);return response({error:'Invalid session. Please sign out, sign back in, then retry.'},401)}
    const {data:profile,error:profileError}=await admin.from('profiles').select('*').eq('id',user.id).single()
    if(profileError||!profile)return response({error:'JPCS profile is not provisioned.'},403)
    if(action==='profile.get')return response({profile})
    if(action==='profile.password'){
      const password=input.password
      if(typeof password!=='string'||password.length<12||password.length>128||password==='JPCS2026')return response({error:'Choose a new password with at least 12 characters.'},400)
      const {error}=await admin.auth.admin.updateUserById(user.id,{password})
      if(error)return response({error:error.message},400)
      const {error:updateError}=await admin.from('profiles').update({must_change_password:false}).eq('id',user.id)
      if(updateError)return response({error:'Password changed, but profile setup failed. Retry the password change.'},500)
      return response({ok:true})
    }
    if(action==='profile.update'){
      const {fullName,studentNumber=null,yearLevel=null}=input
      if(typeof fullName!=='string'||!fullName.trim()){
        return response({error:'Please enter your full name.'},400)
      }
      const trimmedName=fullName.trim()
      const yl=yearLevel?Number(yearLevel):null
      if(yl&&(yl<1||yl>4)){
        return response({error:'Year level must be between 1 and 4.'},400)
      }
      const {data:updated,error:updateErr}=await admin.from('profiles').update({
        full_name:trimmedName,
        student_number:studentNumber?String(studentNumber).trim():null,
        year_level:yl
      }).eq('id',user.id).select().single()
      if(updateErr)return response({error:updateErr.message},400)
      await admin.auth.admin.updateUserById(user.id,{user_metadata:{full_name:trimmedName}}).catch(()=>{})
      return response({ok:true,profile:updated})
    }
    if(action==='members.import'){
      if(profile.role!=='admin')return response({error:'Administrator permissions are required for bulk member imports.'},403)
      const {fingerprint,sourceFilename,expectedRecords=null,detectedRecords,records}=input
      if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))return response({error:'Invalid import fingerprint.'},400)
      if(typeof sourceFilename!=='string'||!sourceFilename.toLowerCase().endsWith('.pdf'))return response({error:'A PDF filename is required.'},400)
      if(!Array.isArray(records)||records.length<1||records.length>10)return response({error:'Submit between 1 and 10 directory records per batch.'},400)
      if(!Number.isSafeInteger(Number(detectedRecords))||Number(detectedRecords)<1)return response({error:'Detected record count is invalid.'},400)
      const expectedCount=expectedRecords==null||expectedRecords===''?null:Number(expectedRecords)
      if(expectedCount!==null&&(!Number.isSafeInteger(expectedCount)||expectedCount<1))return response({error:'Document count hint is invalid.'},400)

      const safeFilename=sourceFilename.replace(/[\\/\u0000-\u001f]/g,'_').slice(0,180)
      const {error:batchError}=await admin.from('student_directory_imports').upsert({fingerprint,source_filename:safeFilename,expected_records:expectedCount,detected_records:Number(detectedRecords),created_by:user.id},{onConflict:'fingerprint',ignoreDuplicates:true})
      if(batchError)return response({error:'Could not create the import record. Apply migration 005_student_directory_import.sql and retry.'},500)
      const {data:batch,error:loadBatchError}=await admin.from('student_directory_imports').select('id').eq('fingerprint',fingerprint).single()
      if(loadBatchError||!batch)return response({error:'Could not load the import record.'},500)

      const results=[]
      const text=(value,max=500)=>typeof value==='string'?value.trim().slice(0,max):''
      for(const record of records){
        const recordIndex=Number(record.recordIndex),hasDirectoryRow=record.directoryRow!==null&&record.directoryRow!==undefined&&record.directoryRow!==''
        const directoryRow=hasDirectoryRow?Number(record.directoryRow):null
        if(!Number.isSafeInteger(recordIndex)||recordIndex<1||hasDirectoryRow&&(!Number.isSafeInteger(directoryRow)||directoryRow<0)){
          results.push({recordIndex:Number.isSafeInteger(recordIndex)?recordIndex:null,directoryRow:Number.isSafeInteger(directoryRow)?directoryRow:null,status:'failed',reason:'Directory row number is invalid.'})
          continue
        }
        const studentNumber=text(record.studentNumber,80)
        const lastName=text(record.lastName,120),firstName=text(record.firstName,120),middleInitial=text(record.middleInitial,30)
        const program=text(record.program,160),sex=text(record.sex,40),sourceEmail=text(record.email,254),email=sourceEmail.toLowerCase()
        const contactNumber=text(record.contactNumber,80),address=text(record.address,500)
        const year=record.yearLevel==null||record.yearLevel===''?null:Number(record.yearLevel)
        const notes=Array.isArray(record.notes)?record.notes.filter((item:any)=>typeof item==='string').slice(0,20).map((item:any)=>text(item,200)):[]
        const base={import_id:batch.id,record_index:recordIndex,directory_row:directoryRow,student_number:studentNumber||null,last_name:lastName||null,first_name:firstName||null,middle_initial:middleInitial||null,program:program||null,year_level:Number.isInteger(year)&&year>=1&&year<=5?year:null,sex:sex||null,email:sourceEmail||null,contact_number:contactNumber||null,address:address||null,notes}
        const {data:existingRecord,error:existingRecordError}=await admin.from('student_directory_records').select('id,status,profile_id').eq('import_id',batch.id).eq('record_index',recordIndex).maybeSingle()
        if(existingRecordError){results.push({recordIndex,directoryRow,status:'failed',reason:'Could not check the import record; apply the required migration and retry.'});continue}
        if(existingRecord&&(existingRecord.status==='imported'||(existingRecord.status==='excluded'&&record.excluded))){
          results.push({recordIndex,directoryRow,status:existingRecord.status==='imported'?'imported':existingRecord.status,profileId:existingRecord.profile_id||null,accountCreated:existingRecord.status==='imported',reason:'This source row was already processed; no data was overwritten.'});continue
        }
        let status='processing',profileId:string|null=null,reason='',failureType='',accountCreated=false
        if(record.excluded){status='excluded';notes.push('Excluded by administrator.')}
        else if(record.duplicateInFile){status='duplicate';reason='Duplicate row identified in the PDF preview.'}
        else if(!firstName||!lastName||!/^\S+@\S+\.\S+$/.test(email)||!Number.isInteger(year)||year<1||year>5){
          status='incomplete';reason='Name, valid email, and year level are required to create a member profile.'
        } else {
          const {data:existingEmail,error:emailError}=await admin.from('profiles').select('id').eq('email',email).maybeSingle()
          if(emailError){status='failed';reason='Could not check existing member emails.'}
          else if(existingEmail){
            const {data:existingAuth}=await admin.auth.admin.getUserById(existingEmail.id)
            const metadata=existingAuth?.user?.app_metadata||{}
            const belongsToThisImport=metadata.jpcs_bulk_import_fingerprint===fingerprint&&Number(metadata.jpcs_bulk_import_row)===recordIndex
            if(belongsToThisImport){status='imported';profileId=existingEmail.id;accountCreated=true;reason='The profile from this import already exists; no data or password was changed.'}
            else {status='duplicate';reason='A member profile already uses this email address.'}
          }
          if(status==='processing'&&studentNumber){
            const {data:existingStudent,error:studentError}=await admin.from('profiles').select('id').eq('student_number',studentNumber).limit(1).maybeSingle()
            if(studentError){status='failed';reason='Could not check existing student numbers.'}
            else if(existingStudent){status='duplicate';reason='A member profile already uses this student number.'}
          }
          if(status==='processing'){
            const fullName=[firstName,middleInitial,lastName].filter(Boolean).join(' ')
            const importMetadata={jpcs_bulk_import_fingerprint:fingerprint,jpcs_bulk_import_row:recordIndex}
            let authUser:any=null
            const {data:createdAccount,error:createAccountError}=await admin.auth.admin.createUser({email,password:'JPCS2026',email_confirm:true,user_metadata:{full_name:fullName},app_metadata:importMetadata})
            if(!createAccountError&&createdAccount.user){authUser=createdAccount.user;accountCreated=true}
            else if(/already|registered|exists/i.test(createAccountError?.message||'')){
              // Recover only auth accounts created by this exact import row. Never
              // adopt or modify an unrelated pre-existing authentication account.
              let page=1
              while(!authUser&&page<=500){
                const {data:userPage,error:userPageError}=await admin.auth.admin.listUsers({page,perPage:100})
                if(userPageError||!userPage?.users?.length)break
                const match=userPage.users.find((candidate:any)=>candidate.email?.toLowerCase()===email)
                if(match){
                  const userMetadata=match.app_metadata||{}
                  if(userMetadata.jpcs_bulk_import_fingerprint===fingerprint&&Number(userMetadata.jpcs_bulk_import_row)===recordIndex){authUser=match;accountCreated=true}
                  break
                }
                if(userPage.users.length<100)break
                page+=1
              }
              if(!authUser){status='duplicate';reason='An authentication account already exists for this email.'}
            } else {status='failed';failureType='account';reason='Could not create the authentication account.'}
            if(authUser){
              const {data:newProfile,error:profileInsertError}=await admin.from('profiles').insert({
                id:authUser.id,full_name:fullName,email,student_number:studentNumber||null,year_level:year,role:'member',must_change_password:true,
                last_name:lastName,first_name:firstName,middle_initial:middleInitial||null,program:program||null,sex:sex||null,contact_number:contactNumber||null,address:address||null
              }).select('id').single()
              if(profileInsertError||!newProfile){
                const {data:linkedProfile}=await admin.from('profiles').select('id').eq('id',authUser.id).maybeSingle()
                if(linkedProfile){status='imported';profileId=linkedProfile.id;reason='The profile from this import already exists; no data or password was changed.'}
                else {status='failed';failureType='profile';reason='The authentication account exists, but the member profile could not be saved. A retry can safely finish linking it.'}
              } else {status='imported';profileId=newProfile.id}
            }
          }
        }

        const stored={...base,status,profile_id:profileId}
        let storeResult:any
        if(existingRecord){
          storeResult=await admin.from('student_directory_records').update(stored).eq('id',existingRecord.id).select('id').single()
        } else {
          storeResult=await admin.from('student_directory_records').insert(stored).select('id').single()
        }
        if(storeResult.error){
          if(status==='imported'&&profileId){
            // The profile still exists; do not delete or overwrite it if staging persistence failed.
            results.push({recordIndex,directoryRow,status:'imported',profileId,accountCreated,reason:'Member profile imported, but the directory audit record could not be saved.'})
          } else results.push({recordIndex,directoryRow,status:'failed',failureType:failureType||'directory',accountCreated,reason:'Could not save this directory row.'})
        } else results.push({recordIndex,directoryRow,status,profileId,accountCreated,failureType,reason})
      }
      return response({ok:true,results})
    }
    if(action==='members.create'){
      if(profile.role==='member')return response({error:'Officer access required.'},403)
      const {fullName,email,password,yearLevel,role}=input
      if(typeof fullName!=='string'||!fullName.trim())return response({error:'Please enter a valid full name.'},400)
      if(typeof email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))return response({error:'Please enter a valid email address.'},400)
      if(typeof password!=='string'||password.length<6||password.length>128)return response({error:'Default password must be at least 6 characters.'},400)
      const yl=yearLevel?Number(yearLevel):null
      if(!yl||yl<1||yl>4)return response({error:'Select a valid year level.'},400)
      const trimmedName=fullName.trim()
      const trimmedEmail=email.trim().toLowerCase()
      const allowedRoles=['member','treasurer','auditor','admin']
      const requestedRole=typeof role==='string'&&allowedRoles.includes(role)?role:'member'
      if(requestedRole!=='member'&&profile.role!=='admin')return response({error:'Only administrators can assign officer or admin roles.'},403)
      const {data:created,error:createError}=await admin.auth.admin.createUser({email:trimmedEmail,password,email_confirm:true,user_metadata:{full_name:trimmedName}})
      if(createError){
        const msg=createError.message||'Could not create member account.'
        if(/already|registered|exists/i.test(msg))return response({error:'An account with this email already exists.'},409)
        return response({error:'Could not create member account. Please try again.'},400)
      }
      const userId=created.user?.id
      if(!userId)return response({error:'Could not create member account. Please try again.'},500)
      const {error:profileError}=await admin.from('profiles').insert({id:userId,full_name:trimmedName,email:trimmedEmail,year_level:yl,role:requestedRole,must_change_password:true})
      if(profileError){
        await admin.auth.admin.deleteUser(userId).catch(()=>{})
        const msg=profileError.message||''
        if(/already|exists|unique/i.test(msg))return response({error:'An account with this email already exists.'},409)
        return response({error:'Could not save member profile. Please try again.'},500)
      }
      return response({ok:true})
    }
    if(action==='members.role'){
      if(profile.role!=='admin')return response({error:'Administrator permissions are required.'},403)
      const {userId,role}=input
      const allowed=['member','treasurer','auditor','admin']
      if(typeof userId!=='string'||!userId)return response({error:'Member ID is required.'},400)
      if(typeof role!=='string'||!allowed.includes(role))return response({error:'Select a valid role.'},400)
      const {error:updateError}=await admin.from('profiles').update({role}).eq('id',userId)
      if(updateError)return response({error:updateError.message||'Could not update role.'},400)
      return response({ok:true})
    }
    if(action==='members.update'){
      if(profile.role!=='admin')return response({error:'Administrator permissions are required.'},403)
      const {userId,fullName,studentNumber=null,yearLevel=null}=input
      if(typeof userId!=='string'||!userId)return response({error:'Member ID is required.'},400)
      if(typeof fullName!=='string'||fullName.trim().length<2||fullName.trim().length>80)return response({error:'Enter a name between 2 and 80 characters.'},400)
      const trimmedStudent=studentNumber==null?'':String(studentNumber).trim()
      if(trimmedStudent.length>40||trimmedStudent&&!/^[A-Za-z0-9-]+$/.test(trimmedStudent))return response({error:'Student number may contain only letters, numbers, and hyphens.'},400)
      const yl=yearLevel==null||yearLevel===''?null:Number(yearLevel)
      if(yl!==null&&(!Number.isInteger(yl)||yl<1||yl>4))return response({error:'Year level must be between 1 and 4.'},400)
      const {data:target,error:targetError}=await admin.from('profiles').select('id').eq('id',userId).maybeSingle()
      if(targetError)return response({error:'Could not find the member profile.'},500)
      if(!target)return response({error:'Member profile not found.'},404)
      if(trimmedStudent){
        const {data:existing,error:studentError}=await admin.from('profiles').select('id').eq('student_number',trimmedStudent).neq('id',userId).limit(1).maybeSingle()
        if(studentError)return response({error:'Could not check student number uniqueness.'},500)
        if(existing)return response({error:'Another member already uses this student number.'},409)
      }
      const {data:updated,error:updateError}=await admin.from('profiles').update({full_name:fullName.trim(),student_number:trimmedStudent||null,year_level:yl}).eq('id',userId).select().single()
      if(updateError)return response({error:'Could not update this member profile.'},400)
      await admin.auth.admin.updateUserById(userId,{user_metadata:{full_name:fullName.trim()}}).catch(()=>{})
      return response({ok:true,profile:updated})
    }
    if(action==='members.delete'){
      if(profile.role!=='admin')return response({error:'Administrator permissions are required.'},403)
      const {userId}=input
      if(typeof userId!=='string'||!userId)return response({error:'Member ID is required.'},400)
      if(userId===user.id)return response({error:'You cannot delete your own account.'},400)
      const {data:target,error:targetError}=await admin.from('profiles').select('id,role,full_name').eq('id',userId).maybeSingle()
      if(targetError)return response({error:'Could not find the member profile.'},500)
      if(!target)return response({error:'Member profile not found.'},404)
      if(target.role==='admin')return response({error:'Administrator accounts cannot be deleted from the Members page.'},403)
      const references=await Promise.all([
        admin.from('registrations').select('id',{count:'exact',head:true}).eq('member_id',userId),
        admin.from('payments').select('id',{count:'exact',head:true}).eq('reviewed_by',userId),
        admin.from('passes').select('id',{count:'exact',head:true}).eq('checked_in_by',userId),
        admin.from('audit_log').select('id',{count:'exact',head:true}).eq('actor',userId)
      ])
      if(references.some(result=>result.error))return response({error:'Could not verify whether this account has linked history.'},500)
      if(references.some(result=>(result.count||0)>0))return response({error:'This member has linked event or audit history and cannot be deleted safely.'},409)
      const {error:deleteError}=await admin.auth.admin.deleteUser(userId)
      if(deleteError)return response({error:'Could not delete this member account.'},400)
      return response({ok:true})
    }
    if(action==='events.delete'){
      if(profile.role!=='admin')return response({error:'Administrator permissions are required to delete events.'},403)
      const {eventId}=input
      if(typeof eventId!=='string'||!eventId)return response({error:'Event ID is required.'},400)
      const {data:event,error:eventError}=await admin.from('events').select('id,name').eq('id',eventId).maybeSingle()
      if(eventError)return response({error:'Could not find the event.'},500)
      if(!event)return response({error:'Event not found.'},404)
      const {count:registrationCount,error:registrationError}=await admin.from('registrations').select('id',{count:'exact',head:true}).eq('event_id',eventId)
      if(registrationError)return response({error:'Could not verify the event registration history.'},500)
      if((registrationCount||0)>0)return response({error:'This event has registrations or payment history and cannot be deleted. Deactivate it instead.'},409)
      const {error:deleteError}=await admin.from('events').delete().eq('id',eventId)
      if(deleteError){
        if((deleteError as any).code==='23503')return response({error:'This event acquired linked history and cannot be deleted. Deactivate it instead.'},409)
        return response({error:'Could not delete this event.'},400)
      }
      return response({ok:true})
    }
    if(profile.must_change_password)return response({error:'Change your password before using JPCS Pay.'},403)

    if(action==='payments.reviewer'){
      const {paymentId}=input
      if(typeof paymentId!=='string'||!/^[-0-9a-f]{36}$/i.test(paymentId))return response({error:'Payment ID is invalid.'},400)
      const {data:payment,error:paymentError}=await admin.from('payments').select('id,registration_id,reviewed_by,reviewed_at').eq('id',paymentId).maybeSingle()
      if(paymentError)return response({error:'Could not load payment review details.'},500)
      if(!payment)return response({error:'Payment not found.'},404)
      if(profile.role==='member'){
        const {data:ownedRegistration,error:registrationError}=await admin.from('registrations').select('id').eq('id',payment.registration_id).eq('member_id',user.id).maybeSingle()
        if(registrationError)return response({error:'Could not verify payment ownership.'},500)
        if(!ownedRegistration)return response({error:'Payment not found.'},404)
      }
      if(!payment.reviewed_by)return response({reviewerName:null,reviewedAt:null})
      const {data:reviewer,error:reviewerError}=await admin.from('profiles').select('full_name').eq('id',payment.reviewed_by).maybeSingle()
      if(reviewerError)return response({error:'Could not load the reviewing officer.'},500)
      return response({reviewerName:reviewer?.full_name||'Officer',reviewedAt:payment.reviewed_at})
    }

    if(action==='events.register_free'){
      const {eventId}=input
      if(!eventId)return response({error:'Event ID is required.'},400)
      const {data:event,error:eventError}=await admin.from('events').select('*').eq('id',eventId).single()
      if(eventError||!event)return response({error:'Event not found.'},404)
      if(!event.active)return response({error:'This event is no longer active.'},400)
      if(Number(event.price)>0)return response({error:'This is a paid event. Please submit payment instead.'},400)
      let {data:registration}=await admin.from('registrations').select('*').eq('member_id',user.id).eq('event_id',eventId).maybeSingle()
      if(!registration){
        const {data:newReg,error:regError}=await admin.from('registrations').insert({member_id:user.id,event_id:eventId,price:0}).select().single()
        if(regError)return response({error:regError.message},400)
        registration=newReg
      }
      let {data:pass}=await admin.from('passes').select('*').eq('registration_id',registration.id).maybeSingle()
      if(!pass){
        const {data:newPass,error:passError}=await admin.from('passes').insert({registration_id:registration.id}).select().single()
        if(passError)return response({error:passError.message},400)
        pass=newPass
        await admin.from('email_outbox').insert({
          dedupe_key:`final:${registration.id}`,
          recipient:profile.email,
          template:'final_payment',
          payload:{name:profile.full_name,event:event.name,total:0,token:pass.token}
        }).maybeSingle()
        dispatchOutbox(admin,resolvedOrigin).catch(e=>console.error('Free registration email delivery deferred:',e.message))
      }
      return response({ok:true,registration,pass})
    }

    if(action==='payments.pay_later'){
      const {eventId}=input
      if(typeof eventId!=='string'||!/^[-0-9a-f]{36}$/i.test(eventId))return response({error:'Event ID is invalid.'},400)
      const {data:registration,error}=await admin.rpc('submit_pay_later',{p_member:user.id,p_event:eventId})
      if(error)return response({error:error.message},400)
      const email=await dispatchOutbox(admin,resolvedOrigin,10,`pay-later:${registration.id}`).catch(error=>{
        console.error('Pay Later email delivery deferred:',error.message)
        return {sent:0,configured:false,error:error.message}
      })
      const {data:emailRecord}=await admin.from('email_outbox').select('sent_at').eq('dedupe_key',`pay-later:${registration.id}`).maybeSingle()
      return response({ok:true,registration,email:{...email,sentAt:emailRecord?.sent_at||null}},201)
    }

    if(action==='payments.delete'){
      if(profile.role!=='admin')return response({error:'Administrator permissions are required to delete payments.'},403)
      const {paymentId}=input
      if(typeof paymentId!=='string'||!/^[-0-9a-f]{36}$/i.test(paymentId))return response({error:'Payment ID is invalid.'},400)
      const {data,error}=await admin.rpc('delete_payment',{p_payment:paymentId,p_actor:user.id})
      if(error)return response({error:error.message},400)
      return response({ok:true,...data})
    }

    if(action==='payments.pay_later.delete'){
      if(profile.role!=='admin')return response({error:'Administrator permissions are required to delete Pay Later obligations.'},403)
      const {registrationId}=input
      if(typeof registrationId!=='string'||!/^[-0-9a-f]{36}$/i.test(registrationId))return response({error:'Registration ID is invalid.'},400)
      const {data,error}=await admin.rpc('delete_pay_later',{p_registration:registrationId,p_actor:user.id})
      if(error)return response({error:error.message},400)
      return response({ok:true,...data})
    }

    if(action==='payments.submit'){
      const {eventId,amount,method,transactionReference='',receiptPath=null}=input
      const paidAmount=Number(amount)
      if(!eventId||!Number.isFinite(paidAmount)||paidAmount<=0||!['cash','gcash','maribank'].includes(method))return response({error:'Check event, amount, and payment method.'},400)
      if(typeof transactionReference!=='string'||transactionReference.length>120)return response({error:'Transaction reference must be 120 characters or fewer.'},400)
      if(method==='cash'&&receiptPath)return response({error:'Cash payment does not accept receipt uploads.'},400)
      if(method!=='cash'&&(!receiptPath||!receiptPath.startsWith(`${user.id}/`)))return response({error:'Upload a receipt before submitting.'},400)
      if(receiptPath&&(!/^[-\w/.]+$/.test(receiptPath)||receiptPath.split('/').length!==2||receiptPath.includes('..')))return response({error:'Invalid receipt path.'},400)
      const {data:payment,error}=await admin.rpc('submit_payment',{p_member:user.id,p_event:eventId,p_amount:paidAmount,p_method:method,p_reference:transactionReference.trim()||null,p_receipt:receiptPath})
      if(error)return response({error:error.message},400)
      return response({payment},201)
    }

    if(action==='payments.review'){
      if(profile.role==='member')return response({error:'Officer access required.'},403)
      const {decision,remarks=''}=input
      if(!['approved','rejected'].includes(decision)||typeof remarks!=='string'||remarks.length>1000)return response({error:'Invalid decision or remarks.'},400)
      if(decision==='rejected'&&!remarks.trim())return response({error:'Add a rejection reason for the member.'},400)
      const {data,error}=await admin.rpc('review_payment',{p_payment:params.paymentId,p_actor:user.id,p_decision:decision,p_remarks:remarks})
      if(error)return response({error:error.message},error.message.includes('already reviewed')?409:400)
      const pass=data.pass
      const result={...data,pass:pass?{...pass,qrDataUrl:await QRCode.toDataURL(`${resolvedOrigin}/verify/${pass.token}`)}:null}
      // Email delivery is attempted after the transaction. If provider delivery
      // fails, the durable outbox entry remains pending for the next dispatch.
      const email=await dispatchOutbox(admin,resolvedOrigin).catch(error=>{console.error('Outbox delivery deferred:',error.message);return {sent:0,configured:false,error:error.message}})
      return response({...result,email})
    }

    if(action==='passes.checkin'){
      if(profile.role==='member')return response({error:'Officer access required.'},403)
      const targetEvent=typeof input.eventId==='string'?input.eventId:''
      const {data:pass}=await admin.from('passes').select('id,checked_in_at,pay_later,registrations(id,event_id,pay_later_due_at,profiles(full_name),events(id,name))').eq('token',params.token).maybeSingle()
      if(!pass)return response({error:'Pass is invalid.'},404)
      const registration=first(pass.registrations)
      const member=first(registration?.profiles)?.full_name||'Member'
      const event=first(registration?.events)?.name||'Event'
      if(targetEvent&&registration?.event_id!==targetEvent)return response({valid:false,wrongEvent:true,passId:pass.id,member,event,message:`This pass belongs to ${event}, not the selected event.`})
      if(pass.pay_later)return response({valid:false,payLater:true,passId:pass.id,member,event,dueAt:registration?.pay_later_due_at||null,message:`Pay Later · unpaid. Due ${registration?.pay_later_due_at?new Date(registration.pay_later_due_at).toLocaleString('en-PH',{dateStyle:'long',timeStyle:'short',timeZone:'Asia/Manila'}):'within 3 days'}. This QR is not an entrance pass until payment is approved.`})
      if(pass.checked_in_at)return response({valid:false,checkedIn:true,checkedInAt:pass.checked_in_at,passId:pass.id,member,event})
      const checkedInAt=new Date().toISOString()
      const {data,error}=await admin.from('passes').update({checked_in_at:checkedInAt,checked_in_by:user.id}).eq('id',pass.id).is('checked_in_at',null).select().maybeSingle()
      if(error||!data){
        const {data:current}=await admin.from('passes').select('checked_in_at,registrations(profiles(full_name),events(name))').eq('id',pass.id).maybeSingle()
        const currentRegistration=first(current?.registrations)
        return response({valid:false,checkedIn:true,checkedInAt:current?.checked_in_at||null,passId:pass.id,member:first(currentRegistration?.profiles)?.full_name||member,event:first(currentRegistration?.events)?.name||event})
      }
      return response({valid:true,passId:pass.id,member,event,checkedInAt})
    }

    if(action==='receipts.url'){
      const {data:payment}=await admin.from('payments').select('receipt_path,registrations(member_id)').eq('id',params.paymentId).maybeSingle()
      if(!payment||(profile.role==='member'&&payment.registrations.member_id!==user.id))return response({error:'Receipt not found.'},404)
      if(!payment.receipt_path)return response({error:'No receipt was uploaded.'},404)
      const {data,error}=await admin.storage.from('payment-receipts').createSignedUrl(payment.receipt_path,90)
      if(error)return response({error:'Could not access receipt.'},500)
      return response({url:data.signedUrl})
    }

    if(action==='passes.qr'){
      const {data:pass}=await admin.from('passes').select('token,registrations(member_id)').eq('id',params.passId).maybeSingle()
      if(!pass||(profile.role==='member'&&pass.registrations.member_id!==user.id))return response({error:'Pass not found.'},404)
      return response({dataUrl:await QRCode.toDataURL(`${resolvedOrigin}/verify/${pass.token}`)})
    }
    return response({error:'Unknown Edge Function action.'},404)
  }catch(error){
    console.error('jpcs-api error:',error.message)
    return response({error:error.message||'Unexpected server error.'},500)
  }
})

async function dispatchOutbox(admin:any,origin:string,limit=10,dedupeKey?:string){
  const brevoKey=Deno.env.get('BREVO_API_KEY'),emailFrom=Deno.env.get('EMAIL_FROM')
  if(!brevoKey||!emailFrom)return {sent:0,configured:false,provider:null}
  let pendingQuery=admin.from('email_outbox').select('*').is('sent_at',null).order('created_at').limit(limit)
  if(dedupeKey)pendingQuery=pendingQuery.eq('dedupe_key',dedupeKey)
  const {data:messages,error}=await pendingQuery
  if(error)throw error
  let sent=0
  const failures:{id:string,error:string}[]=[]
  for(const msg of messages||[]){
    const now=new Date().toISOString()
    let {data:claimed}=await admin.from('email_outbox').update({claimed_at:now}).eq('id',msg.id).is('sent_at',null).is('claimed_at',null).select().maybeSingle()
    if(!claimed){const {data:stale}=await admin.from('email_outbox').update({claimed_at:now}).eq('id',msg.id).is('sent_at',null).lt('claimed_at',new Date(Date.now()-5*60_000).toISOString()).select().maybeSingle();claimed=stale}
    if(!claimed)continue
    try{
      const p=msg.payload||{},final=msg.template==='final_payment',payLater=msg.template==='pay_later'
      const subject=final?'Payment Complete — Your Entrance Pass':payLater?'Pay Later — Payment Due in 3 Days':msg.template==='payment_approved'?'Payment Approved — JPCS-LCC':'Payment Update — JPCS-LCC'
      const memberName=escapeHtml(p.name||'Member')
      const eventName=escapeHtml(p.event||'Event')
      const amount=final?`₱${Number(p.total).toLocaleString('en-PH')}`:''
      let html=`<!DOCTYPE html><html><body style="margin:0;padding:0;background:#eef2f8;font-family:Arial,Helvetica,sans-serif;color:#17213b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f8;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
<tr><td style="background:#101e42;padding:20px 24px;color:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;"><img src="${origin}/images/jpcs-logo.png" alt="JPCS-LCC logo" width="44" height="44" style="display:block;border-radius:8px;background:#ffffff;padding:4px;" /></td>
<td style="padding-left:12px;vertical-align:middle;"><b style="font-size:18px;line-height:1.2;">JPCS-LCC</b><br /><span style="font-size:11px;opacity:.85;">Junior Philippine Computer Society – Lipa City Colleges Chapter</span></td>
</tr></table></td></tr>
<tr><td style="padding:28px 24px 8px;">
<h1 style="margin:0 0 8px;font-size:20px;color:#101e42;">${escapeHtml(subject)}</h1>
<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155;">Hello, ${memberName}! ${final?'Your payment has been verified and your entrance pass is ready.':payLater?'You selected Pay Later for this event. No payment has been received yet. Please pay within 3 days.':'Here is an update on your payment.'}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;border:1px solid #e2e8f0;border-radius:10px;">
<tr><td style="padding:14px 16px;font-size:13px;line-height:1.7;">
<div><span style="color:#6b7794;">Event</span><br /><b>${eventName}</b></div>
${final?`<div style="margin-top:10px;"><span style="color:#6b7794;">Verified amount</span><br /><b>${amount}</b></div>
<div style="margin-top:10px;"><span style="color:#6b7794;">Status</span><br /><b>Verified</b></div>`:''}
${payLater?`<div style="margin-top:10px;"><span style="color:#6b7794;">Status</span><br /><b>Pay Later · Not paid yet</b></div>
<div style="margin-top:10px;"><span style="color:#6b7794;">Amount to pay</span><br /><b>₱${Number(p.amount||0).toLocaleString('en-PH')}</b></div>
<div style="margin-top:10px;"><span style="color:#6b7794;">Payment due</span><br /><b>${escapeHtml(p.due_at?new Date(p.due_at).toLocaleString('en-PH',{dateStyle:'long',timeStyle:'short',timeZone:'Asia/Manila'}):'Within 3 days')}</b></div>`:''}
</td></tr></table>
${final?(p.include_pass_qr===false?`<div style="margin-top:18px;padding:14px 16px;background:#fff8e6;border:1px solid #f1d27a;border-radius:10px;">
<p style="margin:0;font-size:13px;line-height:1.6;color:#17213b;"><b>Your original Pay Later QR is now your entrance pass.</b> The payment has been verified. Keep using the QR from your Pay Later email; no new QR is needed.</p></div>`:`<div style="margin-top:18px;padding:14px 16px;background:#fff8e6;border:1px solid #f1d27a;border-radius:10px;">
<p style="margin:0;font-size:13px;line-height:1.6;color:#17213b;"><b>Entrance pass attached.</b> Your entrance QR pass is attached to this email as <b>jpcs-pass.png</b>. Download it and present the QR code at the event entrance.</p></div>`):payLater?`<div style="margin-top:18px;padding:14px 16px;background:#fff8e6;border:1px solid #f1d27a;border-radius:10px;">
<p style="margin:0;font-size:13px;line-height:1.6;color:#17213b;"><b>Pay Later QR attached.</b> Scan <b>jpcs-pay-later.png</b> to view the event, amount due, unpaid status, and due date.</p></div>`:`<p style="margin-top:16px;font-size:13px;line-height:1.6;color:#334155;">${escapeHtml(p.remarks||'')}</p>`}
</td></tr>
<tr><td style="padding:18px 24px 24px;border-top:1px solid #e2e8f0;">
<p style="margin:0;font-size:11px;line-height:1.6;color:#6b7794;">Junior Philippine Computer Society – Lipa City Colleges Chapter<br />This email was sent by JPCS-LCC.</p>
</td></tr>
</table>
</td></tr></table></body></html>`
      const attachments:{filename:string,content:string}[]=[]
      if(final&&p.token&&p.include_pass_qr!==false){
        const png=await QRCode.toBuffer(`${origin}/verify/${p.token}`)
        attachments.push({filename:'jpcs-pass.png',content:toBase64(png)})
      }
      if(payLater&&p.token){
        const png=await QRCode.toBuffer(`${origin}/verify/${p.token}`)
        attachments.push({filename:'jpcs-pay-later.png',content:toBase64(png)})
      }
      const match=emailFrom.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
      const senderEmail=match?.[2]||emailFrom,senderName=match?.[1]||'JPCS-LCC'
      const emailRequest:{sender:{name:string,email:string},to:{email:string}[],subject:string,htmlContent:string,attachment?:{name:string,content:string}[]}={sender:{name:senderName,email:senderEmail},to:[{email:msg.recipient}],subject,htmlContent:html}
      if(attachments.length)emailRequest.attachment=attachments.map(a=>({name:a.filename,content:a.content}))
      const response=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':brevoKey,'Content-Type':'application/json'},body:JSON.stringify(emailRequest)})
      if(!response.ok)throw new Error(`Brevo returned ${response.status}: ${(await response.text()).slice(0,200)}`)
      await admin.from('email_outbox').update({sent_at:new Date().toISOString(),claimed_at:null}).eq('id',msg.id)
      sent++
    }catch(error){
      await admin.from('email_outbox').update({claimed_at:null}).eq('id',msg.id)
      failures.push({id:msg.id,error:error.message})
      console.error('Email delivery failed:',msg.id,error.message)
    }
  }
  return {sent,failures,configured:true,provider:'brevo'}
}

function toBase64(bytes:Uint8Array){let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary)}
