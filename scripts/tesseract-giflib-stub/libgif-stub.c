/*
 * Export-compatible replacement for giflib's libgif-7.dll in the OCR runtime.
 *
 * libleptonica-6.dll imports exactly these eleven symbols by name, so the DLL
 * must exist for tesseract.exe to load. Every entry point fails the way giflib
 * 5.2 documents failure (gif_lib.h): the openers and the map allocator return
 * NULL, the int-returning calls return GIF_ERROR, and an error-code pointer is
 * written only when it is non-NULL (leptonica passes NULL to both openers).
 * Leptonica checks each of these returns, so a GIF read or write fails cleanly
 * and no GIF bytes are ever parsed or produced.
 *
 * No C runtime: the DLL is linked with /NOENTRY /NODEFAULTLIB and imports
 * nothing.
 */

#include <stddef.h>

#define GIF_ERROR 0
#define E_GIF_ERR_OPEN_FAILED 1
#define E_GIF_ERR_CLOSE_FAILED 9
#define D_GIF_ERR_OPEN_FAILED 101
#define D_GIF_ERR_CLOSE_FAILED 110

typedef struct GifFileType GifFileType;
typedef struct ColorMapObject ColorMapObject;
typedef struct GifColorType GifColorType;
typedef unsigned char GifByteType;
typedef unsigned char GifPixelType;
typedef int (*InputFunc)(GifFileType *, GifByteType *, int);
typedef int (*OutputFunc)(GifFileType *, const GifByteType *, int);

#define EXPORT __declspec(dllexport)

EXPORT GifFileType *DGifOpen(void *userPtr, InputFunc readFunc, int *Error)
{
    (void)userPtr;
    (void)readFunc;
    if (Error != NULL)
        *Error = D_GIF_ERR_OPEN_FAILED;
    return NULL;
}

EXPORT int DGifSlurp(GifFileType *GifFile)
{
    (void)GifFile;
    return GIF_ERROR;
}

EXPORT int DGifCloseFile(GifFileType *GifFile, int *ErrorCode)
{
    (void)GifFile;
    if (ErrorCode != NULL)
        *ErrorCode = D_GIF_ERR_CLOSE_FAILED;
    return GIF_ERROR;
}

EXPORT GifFileType *EGifOpen(void *userPtr, OutputFunc writeFunc, int *Error)
{
    (void)userPtr;
    (void)writeFunc;
    if (Error != NULL)
        *Error = E_GIF_ERR_OPEN_FAILED;
    return NULL;
}

EXPORT int EGifPutScreenDesc(GifFileType *GifFile, const int GifWidth, const int GifHeight,
                             const int GifColorRes, const int GifBackGround,
                             const ColorMapObject *GifColorMap)
{
    (void)GifFile;
    (void)GifWidth;
    (void)GifHeight;
    (void)GifColorRes;
    (void)GifBackGround;
    (void)GifColorMap;
    return GIF_ERROR;
}

EXPORT int EGifPutImageDesc(GifFileType *GifFile, const int GifLeft, const int GifTop,
                            const int GifWidth, const int GifHeight, const int GifInterlace,
                            const ColorMapObject *GifColorMap)
{
    (void)GifFile;
    (void)GifLeft;
    (void)GifTop;
    (void)GifWidth;
    (void)GifHeight;
    (void)GifInterlace;
    (void)GifColorMap;
    return GIF_ERROR;
}

EXPORT int EGifPutLine(GifFileType *GifFile, GifPixelType *GifLine, int GifLineLen)
{
    (void)GifFile;
    (void)GifLine;
    (void)GifLineLen;
    return GIF_ERROR;
}

EXPORT int EGifPutComment(GifFileType *GifFile, const char *GifComment)
{
    (void)GifFile;
    (void)GifComment;
    return GIF_ERROR;
}

EXPORT int EGifCloseFile(GifFileType *GifFile, int *ErrorCode)
{
    (void)GifFile;
    if (ErrorCode != NULL)
        *ErrorCode = E_GIF_ERR_CLOSE_FAILED;
    return GIF_ERROR;
}

EXPORT ColorMapObject *GifMakeMapObject(int ColorCount, const GifColorType *ColorMap)
{
    (void)ColorCount;
    (void)ColorMap;
    return NULL;
}

EXPORT void GifFreeMapObject(ColorMapObject *Object)
{
    (void)Object;
}
