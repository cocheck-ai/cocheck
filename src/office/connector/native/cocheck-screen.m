// cocheck-screen: the small native helper of CoCheck's Office print route. One process per job, spoken to in JSON lines on stdin and stdout.
// Build: scripts/build-helpers.mjs into dist/office/connector/helpers/cocheck-screen (clang per architecture, then lipo; unsigned beyond the linker's ad hoc signature).
//
// It is read-only. It signals nothing, hides nothing, captures nothing, creates no display and deletes nothing. It never asks for, reads or
// needs a Screen Recording grant: without one macOS still lists each window's owner, layer and bounds, which is all `windows` is used for
// (titles may come back empty, and nothing reads them).
//
// Protocol: one JSON object per line. A request may carry a "req" number, which the answer echoes. Answers: {"ok":true,...} or {"ok":false,"why":"..."}.
//   windows {pid}              -> windows [{id, layer, bounds{x,y,w,h}, onscreen, title}]  (kCGWindowListOptionAll, windows of that pid)
//   close                      -> exits 0
// Options: --max-ms <n> exits after n milliseconds. --start-of <pid> (alone) prints the pid's kernel start time as "<seconds>.<microseconds>"
// (epoch) and exits; exit 1 when the pid cannot be read. The Office launch proves a process is its own with it (office-macos.ts `launch`).
// The helper also exits on stdin end-of-file, on a changed parent pid, and on SIGTERM, SIGINT, SIGHUP or SIGQUIT. SIGPIPE is ignored. A request
// field of the wrong type is answered `fail` and the helper keeps running (handle() is wrapped in @try/@catch).
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <sys/sysctl.h>
#include <signal.h>
#include <unistd.h>
#include <stdatomic.h>
#include <math.h>

static NSLock *gOutLock;
static NSMutableArray<NSString *> *gLines;
static NSLock *gLinesLock;
static atomic_flag gExiting = ATOMIC_FLAG_INIT;
static pid_t gParent;

static void spin(double secs) { [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:secs]]; }

static void emit(NSDictionary *d) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  if (data == nil) return;
  [gOutLock lock];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  [gOutLock unlock];
}

/** The one exit path for everything but `close`. */
static void interrupted(void) {
  if (atomic_flag_test_and_set(&gExiting)) return;
  _exit(0);
}

static NSDictionary *fail(NSString *why) { return @{@"ok" : @NO, @"why" : why}; }

/** An integral JSON number (not a bool, string, array, null or fraction) within [lo, hi], else NO. */
static BOOL intField(NSDictionary *r, NSString *key, double lo, double hi, long long *out) {
  id v = r[key];
  if (![v isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)v) == CFBooleanGetTypeID()) return NO;
  double d = [v doubleValue];
  if (!isfinite(d) || d != floor(d) || d < lo || d > hi) return NO;
  *out = (long long)d;
  return YES;
}

static NSDictionary *cmdWindows(NSDictionary *r) {
  long long lp;
  if (!intField(r, @"pid", -2147483648.0, 2147483647.0, &lp)) return fail(@"windows needs a numeric pid");
  pid_t pid = (pid_t)lp;
  NSArray *all = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *w in all) {
    if ([w[(id)kCGWindowOwnerPID] intValue] != pid) continue;
    NSDictionary *b = w[(id)kCGWindowBounds];
    [out addObject:@{@"id" : w[(id)kCGWindowNumber], @"layer" : w[(id)kCGWindowLayer] ?: @0,
                     @"bounds" : @{@"x" : b[@"X"] ?: @0, @"y" : b[@"Y"] ?: @0, @"w" : b[@"Width"] ?: @0, @"h" : b[@"Height"] ?: @0},
                     @"onscreen" : @([w[(id)kCGWindowIsOnscreen] boolValue]), @"title" : w[(id)kCGWindowName] ?: @""}];
  }
  return @{@"ok" : @YES, @"windows" : out};
}

static BOOL handleOne(NSString *line, NSDictionary **reqOut) {
  NSDictionary *r = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (![r isKindOfClass:[NSDictionary class]]) { emit(fail(@"not a JSON object")); return YES; }
  *reqOut = r;
  NSString *cmd = r[@"cmd"];
  NSDictionary *a;
  BOOL keep = YES;
  if ([cmd isEqual:@"windows"]) a = cmdWindows(r);
  else if ([cmd isEqual:@"close"]) { a = @{@"ok" : @YES}; keep = NO; }
  else a = fail(@"unknown command");
  NSMutableDictionary *m = [a mutableCopy];
  if (r[@"req"]) m[@"req"] = r[@"req"];
  emit(m);
  return keep;
}

/** One request. Anything it raises is answered `fail` (with the request's req) and the helper keeps running. */
static BOOL handle(NSString *line) {
  NSDictionary *r = nil;
  @try {
    return handleOne(line, &r);
  } @catch (NSException *e) {
    @try {
      NSMutableDictionary *m = [fail([NSString stringWithFormat:@"request failed: %@", e.name]) mutableCopy];
      id req = r[@"req"];
      if ([req isKindOfClass:[NSNumber class]] || [req isKindOfClass:[NSString class]]) m[@"req"] = req;
      emit(m);
    } @catch (NSException *e2) { /* nothing more to do */ }
    return YES;
  }
}

int main(int argc, char **argv) {
  @autoreleasepool {
    long maxMs = 0;
    // --start-of <pid>: prints that process's start time from the kernel as "<seconds>.<microseconds>" (epoch) and exits; exit 1 when the pid cannot be read. Read only: nothing is
    // signalled or created (the launch proof compares it with the launch's own clock at sub-second precision).
    if (argc == 3 && strcmp(argv[1], "--start-of") == 0) {
      pid_t pid = (pid_t)atol(argv[2]);
      int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
      struct kinfo_proc kp;
      size_t len = sizeof kp;
      memset(&kp, 0, sizeof kp);
      if (pid <= 0 || sysctl(mib, 4, &kp, &len, NULL, 0) != 0 || len < sizeof kp || kp.kp_proc.p_pid != pid) return 1;
      printf("%ld.%06d\n", (long)kp.kp_proc.p_un.__p_starttime.tv_sec, (int)kp.kp_proc.p_un.__p_starttime.tv_usec);
      return 0;
    }
    for (int i = 1; i + 1 < argc; i++) if (strcmp(argv[i], "--max-ms") == 0) maxMs = atol(argv[i + 1]);
    gOutLock = [NSLock new];
    gLinesLock = [NSLock new];
    gLines = [NSMutableArray array];
    gParent = getppid();
    signal(SIGPIPE, SIG_IGN);
    int sigs[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT};
    for (size_t i = 0; i < sizeof sigs / sizeof *sigs; i++) {
      signal(sigs[i], SIG_IGN);
      dispatch_source_t s = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, sigs[i], 0, dispatch_get_global_queue(0, 0));
      dispatch_source_set_event_handler(s, ^{ interrupted(); });
      dispatch_resume(s);
      CFRetain((__bridge CFTypeRef)s);
    }
    // parent death: a changed ppid (backup to stdin end-of-file), and --max-ms
    dispatch_async(dispatch_get_global_queue(0, 0), ^{
      long waited = 0;
      for (;;) {
        usleep(100000);
        waited += 100;
        if (getppid() != gParent) interrupted();
        if (maxMs > 0 && waited >= maxMs) interrupted();
      }
    });
    // stdin reader: lines go to the main thread; end-of-file is a parent that is gone
    dispatch_async(dispatch_get_global_queue(0, 0), ^{
      char *buf = NULL;
      size_t cap = 0;
      ssize_t n;
      while ((n = getline(&buf, &cap, stdin)) > 0) {
        NSString *l = [[NSString alloc] initWithBytes:buf length:(NSUInteger)n encoding:NSUTF8StringEncoding];
        if (l == nil) continue;
        [gLinesLock lock];
        [gLines addObject:l];
        [gLinesLock unlock];
      }
      // let queued commands (a `close` sent just before EOF) finish first
      for (int i = 0; i < 20; i++) { usleep(50000); }
      interrupted();
    });
    emit(@{@"ok" : @YES, @"ready" : @YES, @"pid" : @(getpid())});
    for (;;) {
      spin(0.02);
      NSString *line = nil;
      [gLinesLock lock];
      if (gLines.count > 0) { line = gLines[0]; [gLines removeObjectAtIndex:0]; }
      [gLinesLock unlock];
      if (line == nil) continue;
      if (!handle(line)) break;
    }
    atomic_flag_test_and_set(&gExiting);
    return 0;
  }
}
