/* A stand-in for libsane.so.1 with one device, for the Linux scanner tests.
 *
 * Declarations follow the SANE standard 1.06, chapter 4. The device offers a
 * flatbed, a feeder and a duplex feeder; lineart, grey and colour modes; an
 * integer resolution, millimetre scan area, integer brightness and
 * fixed-point contrast. The feeder holds FAKE_SHEETS sheets and jams before
 * the sheet `fake_sane_set_jam` names (0 = never). Pages from the feeder
 * report an unknown line count. Each page's pixels are a deterministic
 * pattern.
 */
#include <stdlib.h>
#include <string.h>

typedef int SANE_Word;
typedef SANE_Word SANE_Int;
typedef SANE_Word SANE_Bool;
typedef SANE_Word SANE_Fixed;
typedef void *SANE_Handle;
typedef const char *SANE_String_Const;
typedef unsigned char SANE_Byte;

enum { GOOD = 0, UNSUPPORTED = 1, CANCELLED = 2, BUSY = 3, INVAL = 4, EOF_ = 5, JAMMED = 6, NO_DOCS = 7 };
enum { T_BOOL = 0, T_INT = 1, T_FIXED = 2, T_STRING = 3 };
enum { U_NONE = 0, U_PIXEL = 1, U_MM = 3, U_DPI = 4 };
enum { C_NONE = 0, C_RANGE = 1, C_WORDS = 2, C_STRINGS = 3 };
enum { GRAY = 0, RGB = 1 };
#define SOFT_SELECT 1
#define SOFT_DETECT 4
#define INFO_INEXACT 1
#define INFO_RELOAD_OPTIONS 2
#define FIX(v) ((SANE_Fixed)((v) * 65536.0))

typedef struct { SANE_String_Const name, vendor, model, type; } SANE_Device;
typedef struct { SANE_Word min, max, quant; } SANE_Range;
typedef struct {
  SANE_String_Const name, title, desc;
  int type, unit;
  SANE_Int size, cap;
  int constraint_type;
  const void *constraint;
} SANE_Option_Descriptor;
typedef struct {
  int format;
  SANE_Bool last_frame;
  SANE_Int bytes_per_line, pixels_per_line, lines, depth;
} SANE_Parameters;

#ifndef FAKE_SHEETS
#define FAKE_SHEETS 3
#endif
static int jam_at = 0;
void fake_sane_set_jam(int at) { jam_at = at; }

static const SANE_Device dev = {"fake:usb:001", "Spectra", "Test Scanner", "flatbed scanner"};
static const SANE_Device cam = {"fakecam:0", "Spectra", "Test Camera", "still camera"};
static const SANE_Device *devs[] = {&dev, &cam, NULL};

static SANE_String_Const sources[] = {"Flatbed", "ADF", "ADF Duplex", NULL};
static SANE_String_Const modes[] = {"Lineart", "Gray", "Color", NULL};
static const SANE_Range res_range = {75, 600, 25};
static const SANE_Range x_range = {0, FIX(215.9), 0};
static const SANE_Range y_range = {0, FIX(297.0), 0};
static const SANE_Range bright_range = {-100, 100, 1};
static const SANE_Range contrast_range = {FIX(-100), FIX(100), 0};

enum { O_COUNT, O_SOURCE, O_MODE, O_RES, O_TLX, O_TLY, O_BRX, O_BRY, O_BRIGHT, O_CONTRAST, O_N };

static SANE_Option_Descriptor opts[O_N] = {
  {"", "Number of options", "", T_INT, U_NONE, sizeof(SANE_Word), SOFT_DETECT, C_NONE, NULL},
  {"source", "Scan source", "", T_STRING, U_NONE, 32, SOFT_SELECT | SOFT_DETECT, C_STRINGS, sources},
  {"mode", "Scan mode", "", T_STRING, U_NONE, 32, SOFT_SELECT | SOFT_DETECT, C_STRINGS, modes},
  {"resolution", "Scan resolution", "", T_INT, U_DPI, sizeof(SANE_Word), SOFT_SELECT | SOFT_DETECT, C_RANGE, &res_range},
  {"tl-x", "Top-left x", "", T_FIXED, U_MM, sizeof(SANE_Word), SOFT_SELECT | SOFT_DETECT, C_RANGE, &x_range},
  {"tl-y", "Top-left y", "", T_FIXED, U_MM, sizeof(SANE_Word), SOFT_SELECT | SOFT_DETECT, C_RANGE, &y_range},
  {"br-x", "Bottom-right x", "", T_FIXED, U_MM, sizeof(SANE_Word), SOFT_SELECT | SOFT_DETECT, C_RANGE, &x_range},
  {"br-y", "Bottom-right y", "", T_FIXED, U_MM, sizeof(SANE_Word), SOFT_SELECT | SOFT_DETECT, C_RANGE, &y_range},
  {"brightness", "Brightness", "", T_INT, U_NONE, sizeof(SANE_Word), SOFT_SELECT | SOFT_DETECT, C_RANGE, &bright_range},
  {"contrast", "Contrast", "", T_FIXED, U_NONE, sizeof(SANE_Word), SOFT_SELECT | SOFT_DETECT, C_RANGE, &contrast_range},
};

static char source[32] = "Flatbed";
static char mode[32] = "Color";
static SANE_Word res = 150, tlx = 0, tly = 0, brx = FIX(215.9), bry = FIX(297.0), bright = 0;
static SANE_Fixed contrast = 0;
static int open_count = 0, sheet = 0, side = 0, scanning = 0, cancelled = 0;
static long delivered = 0, page_bytes = 0;
static SANE_Parameters params;

int sane_init(SANE_Int *version, void *auth) { (void)auth; if (version) *version = 0x01000000; return GOOD; }
void sane_exit(void) {}
int sane_get_devices(const SANE_Device ***list, SANE_Bool local) { (void)local; *list = devs; return GOOD; }

int sane_open(SANE_String_Const name, SANE_Handle *h) {
  if (strcmp(name, dev.name) != 0) return INVAL;
  open_count++;
  *h = (SANE_Handle)&opts;
  return GOOD;
}
void sane_close(SANE_Handle h) { (void)h; open_count--; }

const SANE_Option_Descriptor *sane_get_option_descriptor(SANE_Handle h, SANE_Int n) {
  (void)h;
  return (n >= 0 && n < O_N) ? &opts[n] : NULL;
}

static int feeder(void) { return strcmp(source, "Flatbed") != 0; }
static int duplex(void) { return strcmp(source, "ADF Duplex") == 0; }

int sane_control_option(SANE_Handle h, SANE_Int n, int action, void *v, SANE_Int *info) {
  (void)h;
  if (info) *info = 0;
  if (n < 0 || n >= O_N) return INVAL;
  if (action == 0) {
    switch (n) {
      case O_COUNT: *(SANE_Word *)v = O_N; break;
      case O_SOURCE: strcpy(v, source); break;
      case O_MODE: strcpy(v, mode); break;
      case O_RES: *(SANE_Word *)v = res; break;
      case O_TLX: *(SANE_Word *)v = tlx; break;
      case O_TLY: *(SANE_Word *)v = tly; break;
      case O_BRX: *(SANE_Word *)v = brx; break;
      case O_BRY: *(SANE_Word *)v = bry; break;
      case O_BRIGHT: *(SANE_Word *)v = bright; break;
      case O_CONTRAST: *(SANE_Word *)v = contrast; break;
    }
    return GOOD;
  }
  if (action != 1 || scanning) return INVAL;
  switch (n) {
    case O_SOURCE: {
      int ok = 0;
      for (int i = 0; sources[i]; i++) if (!strcmp(v, sources[i])) ok = 1;
      if (!ok) return INVAL;
      strcpy(source, v);
      sheet = 0;
      if (info) *info = INFO_RELOAD_OPTIONS;
      break;
    }
    case O_MODE: {
      int ok = 0;
      for (int i = 0; modes[i]; i++) if (!strcmp(v, modes[i])) ok = 1;
      if (!ok) return INVAL;
      strcpy(mode, v);
      break;
    }
    case O_RES: {
      SANE_Word want = *(SANE_Word *)v;
      SANE_Word got = want < 75 ? 75 : want > 600 ? 600 : want;
      got = 75 + ((got - 75) / 25) * 25;
      if (got != want && info) *info = INFO_INEXACT;
      *(SANE_Word *)v = res = got;
      break;
    }
    case O_TLX: tlx = *(SANE_Word *)v; break;
    case O_TLY: tly = *(SANE_Word *)v; break;
    case O_BRX: brx = *(SANE_Word *)v; break;
    case O_BRY: bry = *(SANE_Word *)v; break;
    case O_BRIGHT: bright = *(SANE_Word *)v; break;
    case O_CONTRAST: contrast = *(SANE_Word *)v; break;
    default: return INVAL;
  }
  return GOOD;
}

static void compute(void) {
  double w_mm = (brx - tlx) / 65536.0, h_mm = (bry - tly) / 65536.0;
  int px = (int)(w_mm / 25.4 * res), lines = (int)(h_mm / 25.4 * res);
  int lineart = !strcmp(mode, "Lineart"), color = !strcmp(mode, "Color");
  params.format = color ? RGB : GRAY;
  params.depth = lineart ? 1 : 8;
  params.pixels_per_line = px;
  params.bytes_per_line = lineart ? (px + 7) / 8 : px * (color ? 3 : 1);
  params.bytes_per_line += 2; /* padding beyond the minimum, as the standard allows */
  params.lines = feeder() ? -1 : lines;
  params.last_frame = 1;
  page_bytes = (long)params.bytes_per_line * lines;
}

int sane_get_parameters(SANE_Handle h, SANE_Parameters *p) { (void)h; compute(); *p = params; return GOOD; }

int sane_start(SANE_Handle h) {
  (void)h;
  if (feeder()) {
    int pages = FAKE_SHEETS * (duplex() ? 2 : 1);
    if (jam_at && sheet == jam_at) return JAMMED;
    if (sheet >= pages) return NO_DOCS;
    sheet++;
  }
  cancelled = 0;
  scanning = 1;
  delivered = 0;
  compute();
  return GOOD;
}

int sane_read(SANE_Handle h, SANE_Byte *buf, SANE_Int max, SANE_Int *len) {
  (void)h;
  *len = 0;
  if (cancelled) { scanning = 0; return CANCELLED; }
  if (!scanning) return INVAL;
  long left = page_bytes - delivered;
  if (left <= 0) { scanning = 0; return EOF_; }
  int n = max < 1000 ? max : 1000;
  if (n > left) n = (int)left;
  for (int i = 0; i < n; i++) buf[i] = (SANE_Byte)((delivered + i) * 7 + sheet);
  delivered += n;
  *len = n;
  return GOOD;
}

void sane_cancel(SANE_Handle h) {
  (void)h;
  cancelled = 1;
  scanning = 0;
  if (!feeder()) sheet = 0;
}

int sane_set_io_mode(SANE_Handle h, SANE_Bool m) { (void)h; (void)m; return UNSUPPORTED; }
int sane_get_select_fd(SANE_Handle h, SANE_Int *fd) { (void)h; (void)fd; return UNSUPPORTED; }
SANE_String_Const sane_strstatus(int s) { (void)s; return "status"; }
