import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, Keyboard, QrCode, RefreshCw, ScanLine, X, XCircle } from 'lucide-react'
import { BrowserQRCodeReader } from '@zxing/browser'

const passTokenFromValue=value=>{
  const text=String(value||'').trim()
  if(!text)return ''
  try{
    const url=new URL(text)
    const parts=url.pathname.split('/').filter(Boolean)
    if(parts.length>=2&&parts[parts.length-2]==='verify')return decodeURIComponent(parts[parts.length-1])
  }catch{}
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))return text
  return ''
}

const formatDateTime=value=>value?new Date(value).toLocaleString('en-PH',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):''

function PassQrPreview({pass,api}){
  const [qr,setQr]=useState('')
  const [error,setError]=useState('')
  useEffect(()=>{
    let alive=true
    api(`/api/passes/${pass.id}/qr`,{},'receipt').then(data=>{if(alive)setQr(data.dataUrl)}).catch(err=>{if(alive)setError(err.message||'Could not load this QR code.')})
    return()=>{alive=false}
  },[api,pass.id])
  return <div className="scanner-pass-qr">{qr?<img src={qr} alt={`Entrance QR code for ${pass.registration?.profiles?.full_name||'member'}`}/>:<div className="scanner-qr-placeholder"><QrCode size={24}/><small>{error||'Loading QR…'}</small></div>}</div>
}

function ScannerDetailsModal({type,passes,api,onClose}){
  useEffect(()=>{
    const closeOnEscape=event=>{if(event.key==='Escape')onClose()}
    document.addEventListener('keydown',closeOnEscape)
    return()=>document.removeEventListener('keydown',closeOnEscape)
  },[onClose])
  const showQr=type==='qr'||type==='remaining'
  const title=type==='checked'?'Members checked in':type==='qr'?'Event QR codes':type==='paylater'?'Pay Later passes':'Remaining entry passes'
  const subtitle=type==='checked'?'Members recorded as admitted for this event.':type==='qr'?'Entrance QR codes assigned to this event.':'Passes that have not been checked in yet.'
  return <div className="scanner-details-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><section className="scanner-details-modal" role="dialog" aria-modal="true" aria-labelledby="scanner-details-title">
    <header className="scanner-details-heading"><div><p className="eyebrow">EVENT RECORD</p><h2 id="scanner-details-title">{title}</h2><p>{subtitle}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close details"><X size={18}/></button></header>
    {passes.length?<div className="scanner-details-list">{passes.map(pass=>{
      const member=pass.registration?.profiles||{}
      const name=member.full_name||'Member'
      return <article className={`scanner-detail-pass ${showQr?'has-qr':''}`} key={pass.id}>
        {showQr&&<PassQrPreview pass={pass} api={api}/>}
        <div className="scanner-detail-member"><b>{name}</b><small>{member.email||''}</small><small>{pass.pay_later?'Pay Later':'Entrance pass'}{pass.checked_in_at?` · Checked in ${formatDateTime(pass.checked_in_at)}`:''}</small>{type==='paylater'&&pass.registration?.pay_later_due_at&&<small>Due {formatDateTime(pass.registration.pay_later_due_at)}</small>}</div>
        <span className={`scanner-detail-status ${pass.pay_later?'paylater':pass.checked_in_at?'used':'ready'}`}>{pass.pay_later?'Pay Later':pass.checked_in_at?'Checked in':'Ready'}</span>
      </article>
    })}</div>:<p className="muted scanner-details-empty">No passes match this category for the selected event.</p>}
    <footer className="scanner-details-footer"><button type="button" className="primary" onClick={onClose}>Done</button></footer>
  </section></div>
}

function ResultCard({result}){
  if(!result)return <div className="scanner-result scanner-result-card idle"><div className="result-head"><ScanLine size={20}/><div><b>Ready to scan</b><small>Point the camera at a member's entrance pass.</small></div></div></div>
  const Icon=result.kind==='valid'?CheckCircle2:result.kind==='warning'?AlertTriangle:result.kind==='checking'?RefreshCw:XCircle
  const iconColor=result.kind==='valid'?'#15803d':result.kind==='invalid'?'#dc2626':result.kind==='warning'?'#b45309':'inherit'
  const title=result.kind==='valid'?(result.payLater?'Check-in successful · Pay Later':'Check-in successful'):result.title==='Pay Later'?'Pay Later · Not an entrance pass':result.kind==='warning'?'Already checked in':result.kind==='checking'?'Checking pass…':result.kind==='invalid'&&(result.title==='Wrong event')?'Wrong event':result.title==='Invalid pass'?'Invalid pass':'Scan result'
  return <div className={`scanner-result scanner-result-card ${result.kind}`} role="status" aria-live="polite">
    <div className="result-head"><Icon size={22} color={iconColor}/><div><b>{title}</b>{result.message&&<small>{result.message}</small>}</div></div>
    {(result.member||result.event||result.checkedInAt)&&<div className="result-details">
      {result.member&&<div className="result-row"><span>Member</span><strong>{result.member}</strong></div>}
      {result.event&&<div className="result-row"><span>Event</span><strong>{result.event}</strong></div>}
      {result.checkedInAt&&<div className="result-row"><span>Time</span><strong>{formatDateTime(result.checkedInAt)}</strong></div>}
    </div>}
  </div>
}

export default function CheckInScanner({events,passes,api,onCheckedIn}){
  const [eventId,setEventId]=useState('')
  const [scanning,setScanning]=useState(false)
  const [starting,setStarting]=useState(false)
  const [cameraError,setCameraError]=useState('')
  const [result,setResult]=useState(null)
  const [manual,setManual]=useState('')
  const [memberSearch,setMemberSearch]=useState('')
  const [attendanceFilter,setAttendanceFilter]=useState('all')
  const [detailsType,setDetailsType]=useState('')
  const videoRef=useRef(null)
  const controlsRef=useRef(null)
  const busyRef=useRef(false)
  const pauseUntilRef=useRef(0)
  const lastScanRef=useRef({text:'',at:0})
  const eventRef=useRef(eventId)
  const passesRef=useRef(passes)
  const aliveRef=useRef(true)
  const activeRef=useRef(false)
  const stopScannerRef=useRef(null)
  useEffect(()=>{eventRef.current=eventId},[eventId])
  useEffect(()=>{passesRef.current=passes},[passes])

  const sortedEvents=useMemo(()=>[...events].sort((a,b)=>{
    const at=a.event_date?new Date(a.event_date).getTime():Number.MAX_SAFE_INTEGER
    const bt=b.event_date?new Date(b.event_date).getTime():Number.MAX_SAFE_INTEGER
    return at-bt
  }),[events])

  useEffect(()=>{
    if(eventId||!sortedEvents.length)return
    const now=Date.now()
    const next=sortedEvents.find(e=>!e.event_date||new Date(e.event_date).getTime()>=now)||sortedEvents[0]
    setEventId(next.id)
    eventRef.current=next.id
  },[eventId,sortedEvents])

  useEffect(()=>{
    aliveRef.current=true
    return()=>{
      aliveRef.current=false
      activeRef.current=false
      try{controlsRef.current?.stop()}catch{}
      controlsRef.current=null
      const video=videoRef.current
      if(video?.srcObject){
        try{video.srcObject.getTracks().forEach(track=>track.stop())}catch{}
        video.srcObject=null
      }
    }
  },[])

  const selectedEvent=sortedEvents.find(e=>e.id===eventId)
  const eventPasses=useMemo(()=>passes.filter(p=>(p.event?.id||p.registration?.event_id)===eventId),[passes,eventId])
  const matchingMemberPasses=useMemo(()=>{
    const query=memberSearch.trim().toLowerCase()
    if(!query)return []
    return eventPasses.filter(pass=>{
      if(pass.pay_later)return false
      const member=pass.registration?.profiles||{}
      return [member.full_name,member.email,member.student_number].some(value=>String(value||'').toLowerCase().includes(query))
    }).slice(0,8)
  },[eventPasses,memberSearch])
  const attendance=useMemo(()=>eventPasses.filter(p=>p.checked_in_at&&(attendanceFilter==='all'||(attendanceFilter==='paylater'?p.pay_later:!p.pay_later))).sort((a,b)=>new Date(b.checked_in_at)-new Date(a.checked_in_at)),[eventPasses,attendanceFilter])
  const checkedCount=eventPasses.filter(p=>p.checked_in_at).length
  const entrancePasses=eventPasses.filter(p=>!p.pay_later)
  const checkedEntranceCount=entrancePasses.filter(p=>p.checked_in_at).length
  const checkedInPasses=useMemo(()=>eventPasses.filter(p=>p.checked_in_at).sort((a,b)=>new Date(b.checked_in_at)-new Date(a.checked_in_at)),[eventPasses])
  const payLaterPasses=useMemo(()=>eventPasses.filter(p=>p.pay_later),[eventPasses])
  const remainingPasses=useMemo(()=>entrancePasses.filter(p=>!p.checked_in_at),[entrancePasses])
  const payLaterCount=payLaterPasses.length
  const detailsPasses=detailsType==='checked'?checkedInPasses:detailsType==='qr'?eventPasses:detailsType==='paylater'?payLaterPasses:remainingPasses
  const secureContext=typeof window==='undefined'||window.isSecureContext
  const liveCameraAvailable=secureContext&&!!navigator.mediaDevices?.getUserMedia

  const stopScanner=()=>{
    activeRef.current=false
    try{controlsRef.current?.stop()}catch{}
    controlsRef.current=null
    const video=videoRef.current
    if(video?.srcObject){
      try{video.srcObject.getTracks().forEach(track=>track.stop())}catch{}
      video.srcObject=null
    }
    setScanning(false)
    setStarting(false)
  }
  stopScannerRef.current=stopScanner

  useEffect(()=>{
    const stopWhenHidden=()=>{
      if(document.hidden)stopScannerRef.current?.()
    }
    document.addEventListener('visibilitychange',stopWhenHidden)
    return()=>document.removeEventListener('visibilitychange',stopWhenHidden)
  },[])

  const processToken=async raw=>{
    if(!aliveRef.current)return
    const token=passTokenFromValue(raw)
    if(!token){
      setResult({kind:'invalid',title:'Not a JPCS pass',message:'That QR code or token is not a JPCS entrance pass. Ask the member to open My passes.'})
      return
    }
    const targetEvent=eventRef.current
    if(!targetEvent){
      setResult({kind:'invalid',title:'Select an event first',message:'Choose the event you are checking people into.'})
      return
    }
    const knownPass=passesRef.current.find(p=>p.token===token)
    const knownEventId=knownPass?.event?.id||knownPass?.registration?.event_id
    if(knownPass&&knownEventId&&knownEventId!==targetEvent){
      const knownEvent=knownPass.event?.name||'another event'
      setResult({kind:'invalid',title:'Wrong event',event:knownEvent,message:`This pass belongs to ${knownEvent}, not the selected event.`})
      return
    }
    if(busyRef.current)return
    busyRef.current=true
    setResult({kind:'checking',title:'Checking pass…',message:'Contacting JPCS Pay.'})
    try{
      const data=await api(`/api/passes/${encodeURIComponent(token)}/check-in`,{method:'POST',body:JSON.stringify({eventId:targetEvent})})
      if(!aliveRef.current)return
      if(data.valid){
        setResult({kind:'valid',title:'Valid pass',payLater:data.payLater,member:data.member,event:data.event,checkedInAt:data.checkedInAt,message:data.payLater?'Entry recorded. Payment status: Pay Later.':'Entry recorded.'})
        onCheckedIn?.({...data,token})
        navigator.vibrate?.(80)
      }else if(data.checkedIn){
        setResult({kind:'warning',title:'Already checked in',member:data.member,event:data.event,checkedInAt:data.checkedInAt,payLater:data.payLater,message:data.payLater?'This Pay Later member was already admitted. Payment status: Pay Later.':'This pass was already used.'})
        onCheckedIn?.({...data,token})
        navigator.vibrate?.([60,50,60])
      }else if(data.payLater){
        setResult({kind:'warning',title:'Pay Later',member:data.member,event:data.event,message:data.message||'This member has an unpaid Pay Later balance and cannot be checked in yet.'})
        navigator.vibrate?.([60,50,60])
      }else if(data.invalid){
        setResult({kind:'invalid',title:'Invalid pass',message:data.message||'No JPCS entrance pass matches this QR code.'})
        navigator.vibrate?.([120,60,120])
      }else if(data.wrongEvent){
        setResult({kind:'invalid',title:'Wrong event',member:data.member,event:data.event,message:data.message||'This pass belongs to a different event.'})
        navigator.vibrate?.([120,60,120])
      }else{
        setResult({kind:'invalid',title:'Pass not accepted',message:data.error||'The pass could not be checked in.'})
      }
    }catch(error){
      if(aliveRef.current)setResult({kind:'invalid',title:'Check-in failed',message:error.message})
    }finally{
      busyRef.current=false
      pauseUntilRef.current=Date.now()+2200
    }
  }

  const handleDecoded=text=>{
    const now=Date.now()
    if(!activeRef.current||document.hidden||busyRef.current||now<pauseUntilRef.current)return
    if(lastScanRef.current.text===text&&now-lastScanRef.current.at<5000)return
    lastScanRef.current={text,at:now}
    processToken(text)
  }

  const startScanner=async()=>{
    setCameraError('')
    if(scanning||starting||activeRef.current)return
    if(!eventRef.current){setCameraError('Select the event before starting the camera.');return}
    if(!secureContext){setCameraError('Live camera requires HTTPS. Use Take photo here, or deploy the site to enable continuous scanning.');return}
    if(!liveCameraAvailable){setCameraError('This browser cannot access a camera. Use Take photo or manual token entry.');return}
    if(!videoRef.current){setCameraError('The camera preview is not ready. Try again.');return}
    activeRef.current=true
    setStarting(true)
    try{
      // ZXing decodes synchronously in a timer loop. Lowering the capture size
      // and scan cadence reduces main-thread work, especially on mobile.
      const reader=new BrowserQRCodeReader(undefined,{delayBetweenScanAttempts:750,delayBetweenScanSuccess:1000})
      const controls=await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'},width:{ideal:640,max:800},height:{ideal:480,max:600}}},videoRef.current,(found)=>{if(found&&activeRef.current&&!document.hidden)handleDecoded(found.getText())})
      if(!aliveRef.current||!activeRef.current||document.hidden){controls.stop();return}
      controlsRef.current=controls
      setScanning(true)
    }catch(error){
      activeRef.current=false
      const name=error?.name||''
      setCameraError(name==='NotAllowedError'?'Camera permission was denied. Allow camera access for this site, or use Take photo.':name==='NotFoundError'?'No camera was found on this device. Use Take photo or manual token entry.':`Could not start the camera: ${error?.message||'unknown error'}`)
    }finally{
      if(aliveRef.current)setStarting(false)
    }
  }

  const handlePhoto=async event=>{
    if(scanning)stopScanner()
    const file=event.target.files?.[0]
    event.target.value=''
    if(!file)return
    const url=URL.createObjectURL(file)
    try{
      const reader=new BrowserQRCodeReader()
      const decoded=await reader.decodeFromImageUrl(url)
      await processToken(decoded.getText())
    }catch{
      setResult({kind:'invalid',title:'No QR detected',message:'Take a clearer photo of the member’s entrance pass.'})
    }finally{
      URL.revokeObjectURL(url)
    }
  }

  const checkManual=async event=>{
    event.preventDefault()
    const value=manual
    setManual('')
    await processToken(value)
  }

  return <div className="checkin-scanner">
    <div className="scanner-toolbar">
      <label className="scanner-event"><span>Choose Event</span><select value={eventId} onChange={event=>{setEventId(event.target.value);eventRef.current=event.target.value;setResult(null);setMemberSearch('')}} disabled={scanning||starting}>{!sortedEvents.length&&<option value="">No events available</option>}{sortedEvents.map(event=><option key={event.id} value={event.id}>{event.name}{event.event_date?` · ${new Date(event.event_date).toLocaleDateString('en-PH',{month:'short',day:'numeric'})}`:''}{event.active?'':' (inactive)'}</option>)}</select></label>
      <div className="scanner-actions">
        {scanning?<button className="outline-btn" onClick={stopScanner}>Stop camera</button>:<button className="primary" onClick={startScanner} disabled={starting||!eventId||!liveCameraAvailable} title={!liveCameraAvailable?'Live camera requires HTTPS':undefined}>{starting?'Starting camera…':<>Start camera <Camera size={16}/></>}</button>}
        <label className="outline-btn scanner-photo"><Camera size={15}/> Take photo<input type="file" accept="image/*" capture="environment" onChange={handlePhoto} hidden/></label>
      </div>
    </div>
    {cameraError&&<div className="scanner-notice"><AlertTriangle size={16}/><span>{cameraError}</span></div>}
    {!secureContext&&!cameraError&&<div className="scanner-notice"><AlertTriangle size={16}/><span>Live camera needs an HTTPS site. You can still use Take photo or manual token entry now.</span></div>}
    <div className="scanner-stats">
      <button type="button" className="scanner-stat scanner-stat-action" onClick={()=>setDetailsType('checked')} aria-label={`View ${checkedCount} checked-in members`}><b>{checkedCount}</b><span>Checked in</span><small>View members</small></button>
      <button type="button" className="scanner-stat scanner-stat-action" onClick={()=>setDetailsType('qr')} aria-label={`View ${eventPasses.length} event QR codes`}><b>{eventPasses.length}</b><span>QR codes</span><small>View QR codes</small></button>
      <button type="button" className="scanner-stat scanner-stat-action" onClick={()=>setDetailsType('paylater')} aria-label={`View ${payLaterCount} Pay Later passes`}><b>{payLaterCount}</b><span>Pay Later</span><small>View members</small></button>
      <button type="button" className="scanner-stat scanner-stat-action" onClick={()=>setDetailsType('remaining')} aria-label={`View ${remainingPasses.length} remaining entry passes`}><b>{Math.max(0,entrancePasses.length-checkedEntranceCount)}</b><span>Remaining entry passes</span><small>View passes</small></button>
    </div>
    <div className="scanner-grid">
      <div className="scanner-main">
        <div className={`scanner-camera ${scanning ? 'live' : 'off'}`}>
          <video ref={videoRef} autoPlay muted playsInline/>
          {!scanning&&<div className="scanner-placeholder"><ScanLine size={32}/><b>Camera is off</b><span>Select an event and start the camera, or use Take photo.</span></div>}
          {scanning&&<div className="scanner-frame"><span/></div>}
        </div>
      </div>
      <div className="scanner-side">
        <ResultCard result={result}/>
        <form className="scanner-manual" onSubmit={checkManual}>
          <label><Keyboard size={15}/> Manual pass entry</label>
          <div className="manual-row"><input value={manual} onChange={event=>setManual(event.target.value)} placeholder="Pass token or QR link" disabled={scanning}/><button className="outline-btn" disabled={!manual.trim()||scanning}>Check in</button></div>
        </form>
        <section className="scanner-member-lookup" aria-label="Check in by member">
          <label htmlFor="scanner-member-search">Find a member instead</label>
          <input id="scanner-member-search" type="search" value={memberSearch} onChange={event=>setMemberSearch(event.target.value)} placeholder="Search name, email, or student number" disabled={scanning||starting||!eventId}/>
          {memberSearch.trim()&&<div className="scanner-member-results" aria-live="polite">
            {matchingMemberPasses.length?matchingMemberPasses.map(pass=>{
              const member=pass.registration?.profiles||{}
              const checking=result?.kind==='checking'
              return <div className="scanner-member-result" key={pass.id}>
                <div><b>{member.full_name||'Member'}</b><small>{member.student_number||member.email||'Entrance pass'}</small></div>
                <button type="button" className="outline-btn small" disabled={checking||!!pass.checked_in_at||scanning||starting} onClick={()=>processToken(pass.token)}>{pass.checked_in_at?'Already checked in':checking?'Checking…':'Check in'}</button>
              </div>
            }):<p className="scanner-member-empty">No entrance passes found for this event.</p>}
            {matchingMemberPasses.length===8&&<small className="scanner-member-limit">Showing the first 8 matches. Refine your search.</small>}
          </div>}
        </section>
        {selectedEvent&&<p className="scanner-help">Checking passes for {selectedEvent.name}.</p>}
      </div>
    </div>
    <section className="attendance-history" aria-labelledby="attendance-history-title">
       <div className="attendance-history-heading"><div><p className="eyebrow">EVENT RECORD</p><h3 id="attendance-history-title">Attendance history</h3></div><label className="attendance-filter">Show <select value={attendanceFilter} onChange={e=>setAttendanceFilter(e.target.value)}><option value="all">All</option><option value="paid">Paid</option><option value="paylater">Pay Later</option></select></label><span>{attendance.length}</span></div>
       {attendance.length ? <div className="table-wrap"><table><thead><tr><th>Member</th><th>Checked in</th><th>Payment</th></tr></thead><tbody>{attendance.map(pass=><tr key={pass.id}><td data-label="Member"><b>{pass.registration?.profiles?.full_name||'Member'}</b><small className="method">{pass.registration?.profiles?.email||''}</small></td><td data-label="Checked in">{formatDateTime(pass.checked_in_at)}</td><td data-label="Payment">{pass.pay_later?'Pay Later':'Paid'}</td></tr>)}</tbody></table></div> : <p className="muted attendance-empty">No checked-in members match this filter.</p>}
     </section>
     {detailsType&&<ScannerDetailsModal type={detailsType} passes={detailsPasses} api={api} onClose={()=>setDetailsType('')}/>}
   </div>
}
