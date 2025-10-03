using Microsoft.Graphics.Canvas;
using Microsoft.UI.Xaml.Media.Imaging;
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Windows.ApplicationModel;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;
using Windows.Graphics.DirectX;
using Windows.Graphics.Imaging;
using Windows.Storage;

namespace GainMapStego;

internal static class Helper
{

    public static bool RunAsPackaged { get; private set; }

    static Helper()
    {
        try
        {
            _ = Package.Current;
            RunAsPackaged = true;
        }
        catch { }
    }



    public static string GetFileSizeText(long size)
    {
        const double KB = 1 << 10;
        const double MB = 1 << 20;
        if (size >= MB)
        {
            return $"{size / MB:F2} MB";
        }
        else
        {
            return $"{size / KB:F2} KB";
        }
    }



    public static string GetOutputFolder()
    {
        string outputFolder;
        if (RunAsPackaged)
        {
            outputFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"GainMapStego\Output");
        }
        else
        {
            outputFolder = Path.Combine(AppContext.BaseDirectory, "Output");
        }
        Directory.CreateDirectory(outputFolder);
        return outputFolder;
    }



    public static async Task<byte[]> EncodeAsJpegAsync(WriteableBitmap bitmap, int quality = 95)
    {
        using var softBitmap = SoftwareBitmap.CreateCopyFromBuffer(bitmap.PixelBuffer, BitmapPixelFormat.Bgra8, bitmap.PixelWidth, bitmap.PixelHeight);
        return await EncodeAsJpegAsync(softBitmap, quality);
    }


    public static async Task<byte[]> EncodeAsJpegAsync(SoftwareBitmap bitmap, int quality = 95)
    {
        quality = Math.Clamp(quality, 0, 100);
        byte subSample = quality switch
        {
            >= 90 => 3, // YUV444
            >= 60 => 2, // YUV422
            _ => 1      // YUV420
        };
        var options = new Dictionary<string, BitmapTypedValue>
        {
            ["ImageQuality"] = new BitmapTypedValue(quality / 100f, PropertyType.Single),
            ["JpegYCrCbSubsampling"] = new BitmapTypedValue(subSample, PropertyType.UInt8),
        };
        using var ms = new MemoryStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, ms.AsRandomAccessStream(), options);
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();
        return ms.ToArray();
    }


    public static async Task<byte[]> EncodeAsJpegAsync(CanvasBitmap bitmap, int quality = 95)
    {
        quality = Math.Clamp(quality, 0, 100);
        byte subSample = quality switch
        {
            >= 90 => 3, // YUV444
            >= 60 => 2, // YUV422
            _ => 1      // YUV420
        };
        var options = new Dictionary<string, BitmapTypedValue>
        {
            ["ImageQuality"] = new BitmapTypedValue(quality / 100f, PropertyType.Single),
            ["JpegYCrCbSubsampling"] = new BitmapTypedValue(subSample, PropertyType.UInt8),
        };
        using var ms = new MemoryStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, ms.AsRandomAccessStream(), options);
        BitmapPixelFormat format = bitmap.Format switch
        {
            DirectXPixelFormat.R8G8B8A8UIntNormalized => BitmapPixelFormat.Rgba8,
            DirectXPixelFormat.B8G8R8A8UIntNormalized => BitmapPixelFormat.Rgba8,
            DirectXPixelFormat.R16G16B16A16UIntNormalized => BitmapPixelFormat.Rgba16,
            _ => throw new ArgumentOutOfRangeException($"{bitmap.Format} is not supported."),
        };
        encoder.SetPixelData(format, (BitmapAlphaMode)bitmap.AlphaMode, bitmap.SizeInPixels.Width, bitmap.SizeInPixels.Height, 96, 96, bitmap.GetPixelBytes());
        await encoder.FlushAsync();
        return ms.ToArray();
    }


    public static async Task<byte[]> EncodeAsJpegAsync(byte[] bytes, BitmapPixelFormat pixelFormat, uint width, uint height, int quality = 95)
    {
        quality = Math.Clamp(quality, 0, 100);
        byte subSample = quality switch
        {
            >= 90 => 3, // YUV444
            >= 60 => 2, // YUV422
            _ => 1      // YUV420
        };
        var options = new Dictionary<string, BitmapTypedValue>
        {
            ["ImageQuality"] = new BitmapTypedValue(quality / 100f, PropertyType.Single),
            ["JpegYCrCbSubsampling"] = new BitmapTypedValue(subSample, PropertyType.UInt8),
        };
        using var ms = new MemoryStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, ms.AsRandomAccessStream(), options);
        encoder.SetPixelData(pixelFormat, BitmapAlphaMode.Premultiplied, width, height, 96, 96, bytes);
        await encoder.FlushAsync();
        return ms.ToArray();
    }


    public static void ClipboardSetStorageItems(DataPackageOperation operation, params IStorageItem[] items)
    {
        var data = new DataPackage
        {
            RequestedOperation = operation,
        };
        data.SetStorageItems(items);
        Clipboard.SetContent(data);
    }


}
