# CoCheck's Windows Office host. office-win.ts starts one powershell.exe per job (-NoProfile -NonInteractive -Sta
# -ExecutionPolicy Bypass) and loads this file as a scriptblock. Protocol: one JSON object per line each way. Request {id, op, args};
# reply {id, ok:true, ...} or {id, ok:false, why}. The host exits on stdin EOF, on the exit op, or when Node stops its pid.
# .NET only: no compiled helpers, no Add-Type. The host only ever holds Office objects it created itself; it never attaches to an
# Office the person has open (no active-object lookup of any kind).
# Adding an op: one entry in $Ops below (a scriptblock taking the request's args and returning a hashtable merged into the reply),
# plus one typed method in office-win.ts.

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
# Our own UTF-8 readers and writers on the raw streams, so non-ASCII paths survive whatever the console code page is.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$script:Quit = $false

function Send-Reply([hashtable]$Reply) {
  $stdout.WriteLine((ConvertTo-Json -InputObject $Reply -Compress -Depth 8))
}

# COM calls an Office app turns away while it is busy (RPC_E_CALL_REJECTED 0x80010001, RPC_E_SERVERCALL_RETRYLATER 0x8001010A):
# retried for up to $Ms milliseconds, then the error stands. Every other error stands at once.
function Test-Busy($Err) {
  $e = $Err.Exception
  while ($null -ne $e) {
    if ($e.HResult -eq -2147418111 -or $e.HResult -eq -2147417846) { return $true }
    $e = $e.InnerException
  }
  return $false
}
function Invoke-Busy([scriptblock]$Call, [int]$Ms = 2000) {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      return & $Call
    } catch {
      if (-not (Test-Busy $_) -or $watch.ElapsedMilliseconds -ge $Ms) { throw }
      Start-Sleep -Milliseconds 100
    }
  }
}

$Ops = @{
  hello = {
    param($a)
    @{ version = $PSVersionTable.PSVersion.ToString(); mode = [string]$ExecutionContext.SessionState.LanguageMode }
  }
  selftest = {
    param($a)
    # the busy helper on a stub call that is turned away once, then answers
    $script:tries = 0
    $got = Invoke-Busy {
      $script:tries++
      if ($script:tries -lt 2) { throw (New-Object System.Runtime.InteropServices.COMException 'busy', -2147418111) }
      'answered'
    }
    @{ retried = $script:tries - 1; got = $got; text = [string]$a.text }
  }
  exit = {
    param($a)
    $script:Quit = $true
    @{}
  }
}

# --- lifecycle ops ---
# One entry per Office app this host may launch: $script:Apps[$key] = @{ com; pid; startedAtMs } exists only for an Application object this
# host created AND whose process launch proved new (exactly one new pid of the image, started after the launch began). Anything else is
# released at once and never touched again. Start times are epoch ms (UTC), so Node compares them whatever the TZ or locale.
if ($null -eq $script:Apps) { $script:Apps = @{} }
$script:OfficeSpec = @{
  excel = @{ progId = 'Excel.Application'; image = 'EXCEL' }
  word = @{ progId = 'Word.Application'; image = 'WINWORD' }
  powerpoint = @{ progId = 'PowerPoint.Application'; image = 'POWERPNT' }
}
function Get-OfficeSpec([string]$Key) {
  $s = $script:OfficeSpec[$Key]
  if ($null -eq $s) { throw "unknown app: $Key" }
  $s
}
function Get-StartMs([System.Diagnostics.Process]$P) {
  (New-Object System.DateTimeOffset ($P.StartTime.ToUniversalTime())).ToUnixTimeMilliseconds()
}
function Get-ImagePids([string]$Image) {
  @(Get-Process -Name $Image -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}
function Release-Com($O) {
  if ($null -ne $O) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($O) } catch { } }
}
function Get-Launched([string]$Key) {
  $e = $script:Apps[$Key]
  if ($null -eq $e -or $null -eq $e.com) { throw 'not launched' }
  $e
}
function Get-DocCount([string]$Key, $C) {
  if ($Key -eq 'excel') { return [int]$C.Workbooks.Count }
  if ($Key -eq 'word') { return [int]$C.Documents.Count }
  [int]$C.Presentations.Count
}
function Drop-App([string]$Key) {
  $e = $script:Apps[$Key]
  if ($null -ne $e) { Release-Com $e.com }
  $script:Apps.Remove($Key)
}

$Ops['isRunning'] = {
  param($a)
  $s = Get-OfficeSpec ([string]$a.app)
  @{ running = ((Get-ImagePids $s.image).Count -gt 0) }
}
$Ops['launch'] = {
  param($a)
  $key = [string]$a.app
  $s = Get-OfficeSpec $key
  if ($null -ne $script:Apps[$key]) { throw 'already launched' }
  $began = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $before = Get-ImagePids $s.image
  $com = New-Object -ComObject $s.progId
  $new = @(Get-Process -Name $s.image -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  # No new process: COM handed back an instance that was already running (possibly the person's). Released, never touched.
  if ($new.Count -eq 0) { Release-Com $com; return @{ pid = $null } }
  $started = $null
  if ($new.Count -eq 1) { try { $started = Get-StartMs $new[0] } catch { $started = $null } }
  # Two new pids, an unreadable start time, or a start before the launch began: not provably ours. Released, never touched.
  if ($new.Count -ne 1 -or $null -eq $started -or $started -lt $began) { Release-Com $com; return @{ notOurs = $true } }
  $script:Apps[$key] = @{ com = $com; pid = [int]$new[0].Id; startedAtMs = [long]$started }
  @{ pid = [int]$new[0].Id; startedAtMs = [long]$started }
}
$Ops['ready'] = {
  param($a)
  $key = [string]$a.app
  $c = (Get-Launched $key).com
  # PowerPoint's Application is not made invisible (it refuses); its documents open WithWindow 0 instead.
  if ($key -ne 'powerpoint') { Invoke-Busy { $c.Visible = $false } | Out-Null }
  if ($key -eq 'excel') { Invoke-Busy { $c.DisplayAlerts = $false } | Out-Null }
  elseif ($key -eq 'word') { Invoke-Busy { $c.DisplayAlerts = 0 } | Out-Null }  # wdAlertsNone
  else { Invoke-Busy { $c.DisplayAlerts = 1 } | Out-Null }  # ppAlertsNone
  Invoke-Busy { $c.AutomationSecurity = 3 } | Out-Null  # msoAutomationSecurityForceDisable
  $v = Invoke-Busy { [string]$c.Version }
  @{ ready = $true; version = $v }
}
$Ops['documentCount'] = {
  param($a)
  $key = [string]$a.app
  $c = (Get-Launched $key).com
  @{ count = [int](Invoke-Busy { Get-DocCount $key $c }) }
}
$Ops['quit'] = {
  param($a)
  $key = [string]$a.app
  $c = (Get-Launched $key).com
  $n = [int](Invoke-Busy { Get-DocCount $key $c })
  $uc = $false
  # Excel and Word expose UserControl; PowerPoint's Application may not [I, check live], so only there a failed read counts as false.
  try { $uc = [bool](Invoke-Busy { $c.UserControl }) } catch { if ($key -ne 'powerpoint') { throw } }
  if ($n -ne 0 -or $uc) {
    # The person has documents in it or took it over: it is theirs now. Released, never touched again.
    Drop-App $key
    return @{ refused = $true; documents = $n; userControl = $uc }
  }
  Invoke-Busy { $c.Quit() } | Out-Null
  Drop-App $key
  @{ quit = $true }
}
$Ops['procInfo'] = {
  param($a)
  $p = Get-Process -Id ([int]$a.pid) -ErrorAction SilentlyContinue
  if ($null -eq $p) { return @{ gone = $true } }
  # MainWindowHandle is non-zero only for a visible, unowned top-level window. An unreadable start time throws: Node then refuses.
  @{ image = [string]$p.ProcessName; startedAtMs = [long](Get-StartMs $p); visibleWindow = ($p.MainWindowHandle -ne [IntPtr]::Zero) }
}

# --- export ops ---
# exportPdf {app, input, pdf, printer} and openDocuments {app} act only on the Office this host launched ($script:Apps[$key].com, set
# by launch); pdfPrinter {app} reads what Node needs to pick the PDF printer. Recipes are the ones proven on a real Windows machine: every COM argument typed, the pdf's folder made before the export, every
# call through Invoke-Busy. The person's Windows default printer is never changed: Word is redirected only with FilePrintSetup and
# DoNotSetAsSysDefault = 1 (its ActivePrinter is only ever read: assigning it changes the Windows default); Excel's ActivePrinter is set
# on the open workbook's instance. A redirect whose read-back does not name the PDF printer exports nothing (caveat no-local-pdf-printer),
# so an export never waits on a dead network printer.
$script:WordPrinter = $null
$DummyPassword = 'cocheck-no-password'
$NoPrinter = @{ ok = $false; why = 'no local PDF printer'; caveat = 'no-local-pdf-printer' }
$NoSetup = @{ ok = $false; why = 'PDF printer setup did not take'; caveat = 'pdf-printer-setup-failed' }

function Get-OurApp([string]$Key) {
  $e = $script:Apps[$Key]
  if ($null -eq $e -or $null -eq $e.com) { return $null }
  return $e.com
}

# The read-back names the printer: the full '<name> <on> <port>', or (Word only, as the laptop read it) the bare name.
function Test-ReadBack([string]$Got, $p, [bool]$BareOk) {
  if ($null -eq $p) { return $false }
  return ($Got -eq [string]$p.full) -or ($BareOk -and $Got -eq [string]$p.name)
}

function Export-PowerPoint($com, $a) {
  $doc = Invoke-Busy { $com.Presentations.Open([string]$a.input, [int]-1, [int]0, [int]0) }
  try {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([string]$a.pdf))
    Invoke-Busy { $doc.SaveCopyAs([string]$a.pdf, [int]32) }
  } finally {
    Invoke-Busy { $doc.Close() }
  }
  @{}
}

function Export-Word($com, $a) {
  $p = $a.printer
  if ($null -eq $p) { return $NoPrinter }
  if ($script:WordPrinter -ne [string]$p.full) {
    # once per host, before any document: FilePrintSetup with typed, named arguments (the WordBasic call takes no positional ones)
    $wb = Invoke-Busy { $com.WordBasic }
    Invoke-Busy { [void]$wb.GetType().InvokeMember('FilePrintSetup', [Reflection.BindingFlags]::InvokeMethod, $null, $wb, [object[]]@([string]$p.full, [int]1), $null, $null, [string[]]@('Printer', 'DoNotSetAsSysDefault')) }
    $got = [string](Invoke-Busy { $com.ActivePrinter })
    if (-not (Test-ReadBack $got $p $true)) { return $NoSetup }
    $script:WordPrinter = [string]$p.full
  }
  $doc = Invoke-Busy { $com.Documents.Open([string]$a.input, [bool]$false, [bool]$true, [bool]$false, [string]$DummyPassword) }
  try {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([string]$a.pdf))
    Invoke-Busy { $doc.ExportAsFixedFormat([string]$a.pdf, [int]17) }
  } finally {
    Invoke-Busy { $doc.Close([int]0) }
  }
  @{}
}

function Export-Excel($com, $a) {
  $p = $a.printer
  if ($null -eq $p) { return $NoPrinter }
  $doc = Invoke-Busy { $com.Workbooks.Open([string]$a.input, [int]0, [bool]$true, [Type]::Missing, [string]$DummyPassword) }
  try {
    # after the open (with no workbook it fails 0x800A03EC); the instance's printer, not Windows' default
    $got = Set-ExcelPrinter $com $p
    if (-not (Test-ReadBack $got $p $false)) { return $NoSetup }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([string]$a.pdf))
    Invoke-Busy { $doc.ExportAsFixedFormat([int]0, [string]$a.pdf) }
  } finally {
    Invoke-Busy { $doc.Close([bool]$false) }
  }
  @{}
}

$Ops['pdfPrinter'] = {
  param($a)
  $com = Get-OurApp ([string]$a.app)
  if ($null -eq $com) { return @{ ok = $false; why = 'not launched' } }
  $devices = @{}
  $key = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Devices'
  if (Test-Path -LiteralPath $key) {
    $item = Get-Item -LiteralPath $key
    foreach ($n in $item.GetValueNames()) { $devices[[string]$n] = [string]$item.GetValue($n) }
  }
  $active = ''
  try { $active = [string](Invoke-Busy { $com.ActivePrinter }) } catch { $active = '' }
  @{ devices = $devices; active = $active }
}

$Ops['exportPdf'] = {
  param($a)
  $key = [string]$a.app
  $com = Get-OurApp $key
  if ($null -eq $com) { return @{ ok = $false; why = 'not launched' } }
  switch ($key) {
    'powerpoint' { Export-PowerPoint $com $a }
    'word' { Export-Word $com $a }
    'excel' { Export-Excel $com $a }
    default { @{ ok = $false; why = "unknown app: $key" } }
  }
}

$Ops['openDocuments'] = {
  param($a)
  $key = [string]$a.app
  $com = Get-OurApp $key
  if ($null -eq $com) { return @{ ok = $false; why = 'not launched' } }
  $coll = switch ($key) { 'excel' { Invoke-Busy { $com.Workbooks } } 'word' { Invoke-Busy { $com.Documents } } default { Invoke-Busy { $com.Presentations } } }
  $names = @()
  foreach ($d in $coll) { $names += [string](Invoke-Busy { $d.FullName }) }
  @{ names = [object[]]$names }
}
# --- window list ---
# Read-only: the top-level windows of one pid AND every descendant element of ControlType Window under them (an app's owned modal dialogs are
# children of their owner window in UI Automation, not of the desktop), through .NET UI Automation loaded by assembly name. Reads properties
# only; it never touches a window. Cost bound: the descendant query is limited to the Window control type and every property read comes from
# one CacheRequest, so each row costs no further cross-process calls; the client also holds the whole call to its 5 s timeout. A window whose
# property read throws is skipped, not a failed list. Rows with handle 0 are skipped; a handle is listed once.
$Ops['windows'] = {
  param($a)
  [void][System.Reflection.Assembly]::Load('UIAutomationTypes, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  [void][System.Reflection.Assembly]::Load('UIAutomationClient, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $procId = [int]$a.pid
  $AE = [System.Windows.Automation.AutomationElement]
  $pidCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $procId)
  $winCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $cache = New-Object System.Windows.Automation.CacheRequest
  $cache.Add($AE::NativeWindowHandleProperty)
  $cache.Add($AE::NameProperty)
  $cache.Add($AE::BoundingRectangleProperty)
  $cache.Add($AE::IsOffscreenProperty)
  $cache.Add([System.Windows.Automation.WindowPattern]::WindowVisualStateProperty)
  $cache.Add([System.Windows.Automation.WindowPattern]::Pattern)
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $els = New-Object System.Collections.ArrayList
  $cache.Push()
  try {
    $tops = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)
    foreach ($t in $tops) {
      [void]$els.Add($t)
      try {
        $nested = $t.FindAll([System.Windows.Automation.TreeScope]::Descendants, $winCond)
        foreach ($n in $nested) { [void]$els.Add($n) }
      } catch { continue }
    }
  } finally { $cache.Pop() }
  $list = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($el in $els) {
    try {
      $cur = $el.Cached
      $handle = [int]$cur.NativeWindowHandle
      if ($handle -eq 0 -or $seen.ContainsKey($handle)) { continue }
      $seen[$handle] = $true
      $r = $cur.BoundingRectangle
      $fin = { param($v) if ([double]::IsInfinity($v) -or [double]::IsNaN($v)) { 0 } else { [int]$v } }
      $minimized = $false
      $pat = $null
      if ($el.TryGetCachedPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pat)) {
        $minimized = ($pat.Cached.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized)
      }
      [void]$list.Add(@{
        id = $handle
        layer = 0
        title = [string]$cur.Name
        bounds = @{ x = (& $fin $r.X); y = (& $fin $r.Y); w = (& $fin $r.Width); h = (& $fin $r.Height) }
        onscreen = ((-not $cur.IsOffscreen) -and (-not $minimized))
      })
    } catch { continue }
  }
  @{ windows = @($list) }
}
# --- end window list ---

# --- export targets ---
# exportTargets {app, input, targets, pdfs, printer}: Excel only, one PDF per target sheet from one read-only open of the workbook
# (the same Workbooks.Open and printer redirect as Export-Excel). Per target: PrintCommunication off, that sheet's PageSetup (PrintArea
# from area for a worksheet; Zoom as an int, which makes Excel ignore the fit-to-pages properties, so those are never touched; Orientation
# landscape 2 / portrait 1; a chart sheet takes Orientation only, landscape as on the Mac), PrintCommunication on and read back,
# PrintArea read back, then that sheet's own ExportAsFixedFormat. No sheet's visibility is touched. PrintCommunication is restored in
# a finally on every path, and once more before the workbook closes (unsaved). A failed target is {ok=false, why}; the rest go on.
# Excel's one ActivePrinter assignment (shared by Export-Excel and exportTargets): the instance's printer, returning what Excel reads back.
function Set-ExcelPrinter($com, $p) {
  Invoke-Busy { $com.ActivePrinter = [string]$p.full }
  return [string](Invoke-Busy { $com.ActivePrinter })
}

function Export-ExcelTarget($com, $doc, $t, [string]$pdf) {
  $sh = Invoke-Busy { $doc.Sheets.Item([string]$t.sheet) }
  $isChart = ([string]$t.kind -eq 'chartsheet')
  $orient = if ($isChart -or [bool]$t.landscape) { [int]2 } else { [int]1 }
  $zoom = [int][Math]::Max(10, [Math]::Min(400, [Math]::Round([double]$t.zoom)))
  try {
    Invoke-Busy { $com.PrintCommunication = [bool]$false }
    $ps = Invoke-Busy { $sh.PageSetup }
    if (-not $isChart) {
      Invoke-Busy { $ps.PrintTitleRows = '' }
      Invoke-Busy { $ps.PrintTitleColumns = '' }
      Invoke-Busy { $ps.PrintArea = [string]$t.area }
      # Headings and gridlines on, as on the Mac: the box finder places changes by the printed row and column headings.
      Invoke-Busy { $ps.PrintHeadings = [bool]$true }
      Invoke-Busy { $ps.PrintGridlines = [bool]$true }
      Invoke-Busy { $ps.BlackAndWhite = [bool]$false }
      Invoke-Busy { $ps.CenterHorizontally = [bool]$false }
      Invoke-Busy { $ps.CenterVertically = [bool]$false }
      Invoke-Busy { $ps.Draft = [bool]$false }
      Invoke-Busy { $ps.Zoom = $zoom }
    }
    Invoke-Busy { $ps.Orientation = $orient }
  } finally {
    Invoke-Busy { $com.PrintCommunication = [bool]$true }
    if (-not [bool](Invoke-Busy { $com.PrintCommunication })) { throw 'PrintCommunication did not turn back on' }
  }
  $back = ''
  if (-not $isChart) {
    # Read back as on the Mac: the zoom and the four flags are the file's own print settings that would otherwise leak into the picture.
    $zb = Invoke-Busy { $ps.Zoom }
    if ([int]$zb -ne $zoom) { throw "the print zoom read back as $zb, not $zoom" }
    if ([bool](Invoke-Busy { $ps.BlackAndWhite })) { throw 'the print setting black and white read back as true, not false' }
    if ([bool](Invoke-Busy { $ps.CenterHorizontally })) { throw 'the print setting center horizontally read back as true, not false' }
    if ([bool](Invoke-Busy { $ps.CenterVertically })) { throw 'the print setting center vertically read back as true, not false' }
    if ([bool](Invoke-Busy { $ps.Draft })) { throw 'the print setting draft read back as true, not false' }
    $back = [string](Invoke-Busy { $ps.PrintArea })
  }
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($pdf))
  Invoke-Busy { $sh.ExportAsFixedFormat([int]0, [string]$pdf) }
  return $back
}

$Ops['exportTargets'] = {
  param($a)
  $com = Get-OurApp ([string]$a.app)
  if ($null -eq $com) { return @{ ok = $false; why = 'not launched' } }
  if ([string]$a.app -ne 'excel') { return @{ ok = $false; why = 'cannot print sheets one by one' } }
  $p = $a.printer
  if ($null -eq $p) { return $NoPrinter }
  $doc = Invoke-Busy { $com.Workbooks.Open([string]$a.input, [int]0, [bool]$true, [Type]::Missing, [string]$DummyPassword) }
  $results = @()
  try {
    $got = Set-ExcelPrinter $com $p
    if (-not (Test-ReadBack $got $p $false)) { return $NoSetup }
    $i = 0
    foreach ($t in @($a.targets)) {
      try {
        $back = Export-ExcelTarget $com $doc $t ([string]@($a.pdfs)[$i])
        $r = @{ ok = $true }
        if ($back -ne '') { $r.readBack = $back }
        $results += ,$r
      } catch {
        $results += ,@{ ok = $false; why = [string]$_.Exception.Message }
      }
      $i++
    }
  } finally {
    try { Invoke-Busy { $com.PrintCommunication = [bool]$true } } catch { }
    Invoke-Busy { $doc.Close([bool]$false) }
  }
  @{ results = [object[]]$results }
}

while (-not $script:Quit) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $req = ConvertFrom-Json $line
    $id = $req.id
    $op = $Ops[[string]$req.op]
    if ($null -eq $op) {
      Send-Reply @{ id = $id; ok = $false; why = "unknown op: $($req.op)" }
      continue
    }
    $r = & $op $req.args | Where-Object { $_ -is [hashtable] } | Select-Object -Last 1
    $reply = @{ id = $id; ok = $true }
    if ($null -ne $r) { foreach ($k in $r.Keys) { $reply[$k] = $r[$k] } }
    Send-Reply $reply
  } catch {
    Send-Reply @{ id = $id; ok = $false; why = $_.Exception.Message }
  }
}
