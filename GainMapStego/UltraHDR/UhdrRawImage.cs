using System;
using System.Runtime.InteropServices;

namespace GainMapStego.UltraHDR;

/// <summary>
/// Raw Image Descriptor
/// </summary>
[StructLayout(LayoutKind.Sequential)]
public struct UhdrRawImage
{
    /// <summary>
    /// Pixel Format
    /// </summary>
    public UhdrPixelFormat PixelFormat;
    /// <summary>
    /// Color Gamut
    /// </summary>
    public UhdrColorGamut ColorGamut;
    /// <summary>
    /// Color Transfer
    /// </summary>
    public UhdrColorTransfer ColorTransfer;
    /// <summary>
    /// Color Range
    /// </summary>
    public UhdrColorRange ColorRange;

    /// <summary>
    /// Stored image width
    /// </summary>
    public uint Width;
    /// <summary>
    /// Stored image height
    /// </summary>
    public uint Height;

    /// <summary>
    /// pointer to the top left pixel for each plane
    /// </summary>
    public FixedArray3<IntPtr> Plane;

    /// <summary>
    /// stride in pixels between rows for each plane
    /// </summary>
    public FixedArray3<uint> Stride;


    public unsafe Span<byte> AsSpan(int planeIndex)
    {
        if (planeIndex < 0 || planeIndex > 2)
        {
            throw new ArgumentOutOfRangeException(nameof(planeIndex), "Plane index must be 0, 1, or 2.");
        }
        if (Plane[planeIndex] == IntPtr.Zero)
        {
            throw new InvalidOperationException($"Plane {planeIndex} pointer is null.");
        }
        if (Stride[planeIndex] == 0)
        {
            throw new InvalidOperationException($"Plane {planeIndex} stride is zero.");
        }
        int bytesPerPixel = PixelFormat switch
        {
            UhdrPixelFormat._24bppRGB888 => 3,
            UhdrPixelFormat._32bppRGBA1010102 => 4,
            UhdrPixelFormat._32bppRGBA8888 => 4,
            UhdrPixelFormat._64bppRGBAHalfFloat => 8,
            _ => throw new NotSupportedException($"Unsupported pixel format: {PixelFormat}"),
        };
        return new Span<byte>(Plane[planeIndex].ToPointer(), (int)(Stride[planeIndex] * Height * bytesPerPixel));
    }






}


public struct UhdrRawImagePtr
{
    private IntPtr _ptr;
    public bool IsNull => _ptr == IntPtr.Zero;

    public UhdrRawImage ToRawImage()
    {
        if (IsNull)
        {
            throw new InvalidOperationException("Pointer is null. Cannot convert to UhdrRawImage.");
        }
        return Marshal.PtrToStructure<UhdrRawImage>(_ptr);
    }
}
