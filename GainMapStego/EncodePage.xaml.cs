using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GainMapStego.Codec;
using GainMapStego.UltraHDR;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.Windows.Storage.Pickers;
using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;
using Windows.Graphics.DirectX;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.System;


namespace GainMapStego;

[ObservableObject]
public sealed partial class EncodePage : Page
{


    public EncodePage()
    {
        InitializeComponent();
    }




    public ImageSource? BaseImageSource { get; set => SetProperty(ref field, value); }

    public ImageSource? AlternateImageSource { get; set => SetProperty(ref field, value); }

    public string? BaseImagePixelSize { get; set => SetProperty(ref field, value); }

    public string? AlternateImagePixelSize { get; set => SetProperty(ref field, value); }

    private string? _baseImageFileName;

    private string? _alternateImageFileName;

    private byte[]? _baseImageBytes;

    private byte[]? _alternateImageBytes;


    private byte[]? _encodedJpegBytes;

    private string? _encodedJpegName;

    public bool IsEncodeEnabled { get; set => SetProperty(ref field, value); }

    public bool IsEncodedSuccess { get; set => SetProperty(ref field, value); }

    public ImageSource? EncodedBaseImageSource { get; set => SetProperty(ref field, value); }

    public ImageSource? EncodedAlternateImageSource { get; set => SetProperty(ref field, value); }

    public string? EncodedJpegFileSize { get; set => SetProperty(ref field, value); }

    public string? EncodedJpegPixelSize { get; set => SetProperty(ref field, value); }


    public int DisplayReusltIndex
    {
        get; set
        {
            if (SetProperty(ref field, value))
            {
                Image_DisplayResultBase.Visibility = value is 0 ? Visibility.Visible : Visibility.Collapsed;
                Image_DisplayResultAlternate.Visibility = value is 0 ? Visibility.Collapsed : Visibility.Visible;
            }
        }
    }



    [RelayCommand]
    private void Reset()
    {
        IsEncodeEnabled = false;
        IsEncodedSuccess = false;
        BaseImageSource = null;
        AlternateImageSource = null;
        BaseImagePixelSize = null;
        AlternateImagePixelSize = null;
        EncodedBaseImageSource = null;
        EncodedAlternateImageSource = null;
        EncodedJpegFileSize = null;
        EncodedJpegPixelSize = null;
        DisplayReusltIndex = 0;
        _baseImageFileName = null;
        _alternateImageFileName = null;
        _baseImageBytes = null;
        _alternateImageBytes = null;
        _encodedJpegBytes = null;
    }


    private void CheckIsEncodeEnabled()
    {
        IsEncodeEnabled = AlternateImageSource is not null && _alternateImageBytes is not null;
    }



    #region Open File


    private void Grid_DragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            e.AcceptedOperation = DataPackageOperation.Copy;
        }
    }


    private async void Grid_BaseImage_Drop(object sender, DragEventArgs e)
    {
        var defer = e.GetDeferral();
        try
        {
            var items = await e.DataView.GetStorageItemsAsync();
            if (items.Where(x => x.IsOfType(StorageItemTypes.File)).Cast<StorageFile>().FirstOrDefault() is StorageFile file)
            {
                (BaseImageSource, _baseImageBytes, BaseImagePixelSize) = await GetImageAsync(file);
                _baseImageFileName = file.Name;
                if (string.IsNullOrWhiteSpace(_baseImageFileName))
                {
                    _baseImageFileName = DateTimeOffset.Now.ToUnixTimeSeconds().ToString();
                }
                CheckIsEncodeEnabled();
            }
        }
        catch (IOException ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
        catch (Exception ex)
        {
            InfoBar.Error("解码失败", ex.Message);
        }
        finally
        {
            defer.Complete();
        }
    }


    private async void Grid_AlternateImage_Drop(object sender, DragEventArgs e)
    {
        var defer = e.GetDeferral();
        try
        {
            var items = await e.DataView.GetStorageItemsAsync();
            if (items.Where(x => x.IsOfType(StorageItemTypes.File)).Cast<StorageFile>().FirstOrDefault() is StorageFile file)
            {
                (AlternateImageSource, _alternateImageBytes, AlternateImagePixelSize) = await GetImageAsync(file);
                _alternateImageFileName = file.Name;
                if (string.IsNullOrWhiteSpace(_alternateImageFileName))
                {
                    _alternateImageFileName = DateTimeOffset.Now.ToUnixTimeSeconds().ToString();
                }
                CheckIsEncodeEnabled();
            }
        }
        catch (IOException ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
        catch (Exception ex)
        {
            InfoBar.Error("解码失败", ex.Message);
        }
        finally
        {
            defer.Complete();
        }
    }


    [RelayCommand]
    private async Task OpenBaseImageAsync()
    {
        try
        {
            var picker = new FileOpenPicker(this.XamlRoot.ContentIslandEnvironment.AppWindowId);
            picker.FileTypeFilter.Add(".jpg");
            picker.FileTypeFilter.Add(".png");
            picker.FileTypeFilter.Add(".webp");
            picker.FileTypeFilter.Add(".heic");
            picker.FileTypeFilter.Add(".heif");
            picker.FileTypeFilter.Add(".avif");
            picker.FileTypeFilter.Add(".jxl");
            var fileResult = await picker.PickSingleFileAsync();
            if (File.Exists(fileResult?.Path))
            {
                (BaseImageSource, _baseImageBytes, BaseImagePixelSize) = await GetImageAsync(fileResult.Path);
                _baseImageFileName = Path.GetFileName(fileResult.Path);
            }
            CheckIsEncodeEnabled();
        }
        catch (IOException ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
        catch (Exception ex)
        {
            InfoBar.Error("解码失败", ex.Message);
        }
    }


    [RelayCommand]
    private async Task OpenAlternateImageAsync()
    {
        try
        {
            var picker = new FileOpenPicker(this.XamlRoot.ContentIslandEnvironment.AppWindowId);
            picker.FileTypeFilter.Add(".jpg");
            picker.FileTypeFilter.Add(".png");
            picker.FileTypeFilter.Add(".webp");
            picker.FileTypeFilter.Add(".heic");
            picker.FileTypeFilter.Add(".heif");
            picker.FileTypeFilter.Add(".avif");
            picker.FileTypeFilter.Add(".jxl");
            var fileResult = await picker.PickSingleFileAsync();
            if (File.Exists(fileResult?.Path))
            {
                (AlternateImageSource, _alternateImageBytes, AlternateImagePixelSize) = await GetImageAsync(fileResult.Path);
                _alternateImageFileName = Path.GetFileName(fileResult.Path);
            }
            CheckIsEncodeEnabled();
        }
        catch (IOException ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
        catch (Exception ex)
        {
            InfoBar.Error("解码失败", ex.Message);
        }
    }


    private async Task<(ImageSource Source, byte[] Bytes, string PixelSize)> GetImageAsync(StorageFile file)
    {
        using var fs = await file.OpenReadAsync();
        byte[] bytes = new byte[fs.Size];
        fs.AsStream().ReadExactly(bytes);
        var decoder = await BitmapDecoder.CreateAsync(new MemoryStream(bytes).AsRandomAccessStream());
        ImageSource source;
        if (string.IsNullOrWhiteSpace(file.Path))
        {
            using var software = await decoder.GetSoftwareBitmapAsync();
            var bitmap = new WriteableBitmap(software.PixelWidth, software.PixelHeight);
            software.CopyToBuffer(bitmap.PixelBuffer);
            source = bitmap;
        }
        else
        {
            source = new BitmapImage(new Uri(file.Path));
        }
        return (source, bytes, $"{decoder.PixelWidth} x {decoder.PixelHeight}");
    }


    private async Task<(ImageSource Source, byte[] Bytes, string PixelSize)> GetImageAsync(string path)
    {
        using var fs = File.OpenRead(path);
        var decoder = await BitmapDecoder.CreateAsync(fs.AsRandomAccessStream());
        fs.Position = 0;
        byte[] bytes = new byte[fs.Length];
        fs.ReadExactly(bytes);
        ImageSource source = new BitmapImage(new Uri(path));
        return (source, bytes, $"{decoder.PixelWidth} x {decoder.PixelHeight}");
    }


    #endregion




    #region Encode



    [RelayCommand]
    private async Task EncodeAsync()
    {
        try
        {
            CheckIsEncodeEnabled();
            if (!IsEncodeEnabled)
            {
                return;
            }

            Vector3 gamma = new((float)Slider_GainmapGamma.Value);
            Vector3 offsetHdr = new((float)Slider_GainmapOffset.Value);
            Vector3 offsetSdr = offsetHdr;

            int width, height;
            BitmapDecoder? baseDecoder = null;
            if (_baseImageBytes is null)
            {
                _baseImageFileName = ColorPicker_ImageBackground.Color.ToString();
            }
            else
            {
                baseDecoder = await BitmapDecoder.CreateAsync(new MemoryStream(_baseImageBytes).AsRandomAccessStream());
            }
            BitmapDecoder alternateDecoder = await BitmapDecoder.CreateAsync(new MemoryStream(_alternateImageBytes!).AsRandomAccessStream());
            double imageScale = Math.Clamp(Slider_ImageScale.Value, 0.1, 1);
            if (Segmented_TargetDisplay.SelectedIndex == 0 && baseDecoder is not null)
            {
                width = (int)Math.Round(baseDecoder.PixelWidth * imageScale);
                height = (int)Math.Round(baseDecoder.PixelHeight * imageScale);
            }
            else
            {
                width = (int)Math.Round(alternateDecoder.PixelWidth * imageScale);
                height = (int)Math.Round(alternateDecoder.PixelHeight * imageScale);
            }
            EncodedJpegPixelSize = $"{width} x {height}";

            using var baseBitmap = new CanvasRenderTarget(CanvasDevice.GetSharedDevice(), width, height, 96, DirectXPixelFormat.R8G8B8A8UIntNormalized, CanvasAlphaMode.Premultiplied);
            using (var ds = baseBitmap.CreateDrawingSession())
            {
                ds.Clear(ColorPicker_ImageBackground.Color);
                if (baseDecoder is not null)
                {
                    using var baseSoftware = await baseDecoder?.GetSoftwareBitmapAsync(BitmapPixelFormat.Rgba8, BitmapAlphaMode.Premultiplied, new BitmapTransform(), ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage);
                    using var bitmap = CanvasBitmap.CreateFromSoftwareBitmap(CanvasDevice.GetSharedDevice(), baseSoftware);
                    Rect sourceRect = new(new(), bitmap.Size);
                    double scale = Segmented_ScaleMode.SelectedIndex == 0
                                 ? Math.Min(width / bitmap.Size.Width, height / bitmap.Size.Height)
                                 : Math.Max(width / bitmap.Size.Width, height / bitmap.Size.Height);
                    Rect destRect = new((width - bitmap.Size.Width * scale) / 2, (height - bitmap.Size.Height * scale) / 2, bitmap.Size.Width * scale, bitmap.Size.Height * scale);
                    ds.DrawImage(bitmap, destRect, sourceRect, 1, CanvasImageInterpolation.HighQualityCubic);
                }
            }
            var encodedBaseSource = new CanvasImageSource(CanvasDevice.GetSharedDevice(), baseBitmap.SizeInPixels.Width, baseBitmap.SizeInPixels.Height, 96);
            using (var ds = encodedBaseSource.CreateDrawingSession(Colors.Transparent))
            {
                ds.DrawImage(baseBitmap);
            }

            using var alternateBitmap = new CanvasRenderTarget(CanvasDevice.GetSharedDevice(), width, height, 96, DirectXPixelFormat.R8G8B8A8UIntNormalized, CanvasAlphaMode.Premultiplied);
            using (var ds = alternateBitmap.CreateDrawingSession())
            {
                using var alternateSoftware = await alternateDecoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Rgba8, BitmapAlphaMode.Premultiplied, new BitmapTransform(), ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage);
                using var bitmap = CanvasBitmap.CreateFromSoftwareBitmap(CanvasDevice.GetSharedDevice(), alternateSoftware);
                Rect sourceRect = new(new(), bitmap.Size);
                double scale = Segmented_ScaleMode.SelectedIndex == 0
                             ? Math.Min(width / bitmap.Size.Width, height / bitmap.Size.Height)
                             : Math.Max(width / bitmap.Size.Width, height / bitmap.Size.Height);
                Rect destRect = new((width - bitmap.Size.Width * scale) / 2, (height - bitmap.Size.Height * scale) / 2, bitmap.Size.Width * scale, bitmap.Size.Height * scale);
                ds.Clear(ColorPicker_ImageBackground.Color);
                ds.DrawImage(bitmap, destRect, sourceRect, 1, CanvasImageInterpolation.HighQualityCubic);
            }
            var encodedAlternateSource = new CanvasImageSource(CanvasDevice.GetSharedDevice(), alternateBitmap.SizeInPixels.Width, alternateBitmap.SizeInPixels.Height, 96);
            using (var ds = encodedAlternateSource.CreateDrawingSession(Colors.Transparent))
            {
                ds.DrawImage(alternateBitmap);
            }

            using var linearRecoveryBitmap = new CanvasRenderTarget(CanvasDevice.GetSharedDevice(), width, height, 96, DirectXPixelFormat.R32G32B32A32Float, CanvasAlphaMode.Premultiplied);
            using (var ds = linearRecoveryBitmap.CreateDrawingSession())
            {
                using var effect = new UhdrPixelLinearRecoveryEffect
                {
                    SdrSource = new SrgbGammaEffect
                    {
                        Source = baseBitmap,
                        GammaMode = SrgbGammaMode.EOTF,
                        BufferPrecision = CanvasBufferPrecision.Precision16Float,
                    },
                    HdrSource = new SrgbGammaEffect
                    {
                        Source = alternateBitmap,
                        GammaMode = SrgbGammaMode.EOTF,
                        BufferPrecision = CanvasBufferPrecision.Precision16Float,
                    },
                    BufferPrecision = CanvasBufferPrecision.Precision16Float,
                    OffsetHdr = offsetHdr,
                    OffsetSdr = offsetSdr,
                };
                ds.DrawImage(effect);
            }
            var linearRecoveryPixelBytes = linearRecoveryBitmap.GetPixelBytes();
            var contentBoost = GetContentMinMaxBoost(linearRecoveryPixelBytes);

            using var gainmapBitmap = new CanvasRenderTarget(CanvasDevice.GetSharedDevice(), width, height, 96, DirectXPixelFormat.R8G8B8A8UIntNormalized, CanvasAlphaMode.Premultiplied);
            using (var ds = gainmapBitmap.CreateDrawingSession())
            {
                using var effect = new UhdrGainmapEffect
                {
                    PixelLinearRecoverySource = linearRecoveryBitmap,
                    BufferPrecision = CanvasBufferPrecision.Precision16Float,
                    MinContentBoost = new Vector3(contentBoost.AsSpan()[..3]),
                    MaxContentBoost = new Vector3(contentBoost.AsSpan()[^3..]),
                    Gamma = gamma,
                };
                ds.DrawImage(effect);
            }

            byte[] baseJpegBytes = await Helper.EncodeAsJpegAsync(baseBitmap, (int)Math.Round(Slider_ImageQuality.Value));
            byte[] gainmapJpegBytes = await Helper.EncodeAsJpegAsync(gainmapBitmap, (int)Math.Round(Slider_ImageQuality.Value));

            using var encoder = new UhdrEncoder();
            encoder.SetCompressedImage(UhdrImageLabel.Base, baseJpegBytes, UhdrColorGamut.BT709, UhdrColorTransfer.SRGB, UhdrColorRange.FullRange);
            float max = MathF.Max(MathF.Max(contentBoost[3], contentBoost[4]), MathF.Max(contentBoost[5], 1.0001f));
            max = max % 1 == 0 ? max + 0.0001f : max;
            UhdrGainmapMetadata metadata = new UhdrGainmapMetadata
            {
                Gamma = gamma,
                OffsetSdr = offsetSdr,
                OffsetHdr = offsetHdr,
                HdrCapacityMin = 1,
                HdrCapacityMax = max,
                UseBaseColorSpace = 1,
            };
            metadata.MinContentBoost[0] = contentBoost[0];
            metadata.MinContentBoost[1] = contentBoost[1];
            metadata.MinContentBoost[2] = contentBoost[2];
            metadata.MaxContentBoost[0] = contentBoost[3];
            metadata.MaxContentBoost[1] = contentBoost[4];
            metadata.MaxContentBoost[2] = contentBoost[5];
            encoder.SetGainmapImage(metadata, gainmapJpegBytes, UhdrColorGamut.BT709, UhdrColorTransfer.SRGB, UhdrColorRange.FullRange);

            await Task.Run(encoder.Encode);

            _encodedJpegName = $"{Path.GetFileNameWithoutExtension(_baseImageFileName)}_{Path.GetFileNameWithoutExtension(_alternateImageFileName)}.jpg";
            _encodedJpegBytes = encoder.GetEncodedBytes().ToArray();
            EncodedJpegFileSize = Helper.GetFileSizeText(_encodedJpegBytes.LongLength);
            EncodedBaseImageSource = encodedBaseSource;
            EncodedAlternateImageSource = encodedAlternateSource;
            IsEncodedSuccess = true;
        }
        catch (Exception ex)
        {
            IsEncodedSuccess = false;
            InfoBar.Error("合并出错", ex.Message);
        }
    }





    /// <summary>
    /// return min rgb, max rgb
    /// </summary>
    /// <param name="pixelBytes"></param>
    /// <returns></returns>
    public static float[] GetContentMinMaxBoost(byte[] pixelBytes)
    {
        const float PQ_MAX = 10000f / 203;
        float[] contentBoost = [PQ_MAX, PQ_MAX, PQ_MAX, 0, 0, 0];
        var span = MemoryMarshal.Cast<byte, float>(pixelBytes);
        if (Vector.IsHardwareAccelerated && Vector<float>.Count % 4 == 0)
        {
            Vector<float> minBoost = new Vector<float>(PQ_MAX);
            Vector<float> maxBoost = new Vector<float>(0);
            int remaining = span.Length % Vector<float>.Count;
            for (int i = 0; i < span.Length - remaining; i += Vector<float>.Count)
            {
                var value = new Vector<float>(span.Slice(i, Vector<float>.Count));
                minBoost = Vector.Min(minBoost, value);
                maxBoost = Vector.Max(maxBoost, value);
            }
            for (int i = 0; i < Vector<float>.Count; i += 4)
            {
                contentBoost[0] = MathF.Min(contentBoost[0], minBoost[i]);
                contentBoost[1] = MathF.Min(contentBoost[1], minBoost[i + 1]);
                contentBoost[2] = MathF.Min(contentBoost[2], minBoost[i + 2]);
                contentBoost[3] = MathF.Max(contentBoost[3], maxBoost[i]);
                contentBoost[4] = MathF.Max(contentBoost[4], maxBoost[i + 1]);
                contentBoost[5] = MathF.Max(contentBoost[5], maxBoost[i + 2]);
            }
            for (int i = span.Length - remaining; i < span.Length; i += 4)
            {
                contentBoost[0] = MathF.Min(contentBoost[0], span[i]);
                contentBoost[1] = MathF.Min(contentBoost[1], span[i + 1]);
                contentBoost[2] = MathF.Min(contentBoost[2], span[i + 2]);
                contentBoost[3] = MathF.Max(contentBoost[3], span[i]);
                contentBoost[4] = MathF.Max(contentBoost[4], span[i + 1]);
                contentBoost[5] = MathF.Max(contentBoost[5], span[i + 2]);
            }
        }
        else
        {
            for (int i = 0; i < span.Length; i += 4)
            {
                contentBoost[0] = MathF.Min(contentBoost[0], span[i]);
                contentBoost[1] = MathF.Min(contentBoost[1], span[i + 1]);
                contentBoost[2] = MathF.Min(contentBoost[2], span[i + 2]);
                contentBoost[3] = MathF.Max(contentBoost[3], span[i]);
                contentBoost[4] = MathF.Max(contentBoost[4], span[i + 1]);
                contentBoost[5] = MathF.Max(contentBoost[5], span[i + 2]);
            }
        }
        return contentBoost;
    }



    [RelayCommand]
    private async Task CopyAsync()
    {
        try
        {

            if (_encodedJpegBytes is not null)
            {
                string name = _encodedJpegName ?? $"{DateTimeOffset.Now.ToUnixTimeSeconds()}.jpg";
                string path = Path.Combine(Helper.GetOutputFolder(), name);
                await File.WriteAllBytesAsync(path, _encodedJpegBytes);
                var file = await StorageFile.GetFileFromPathAsync(path);
                Helper.ClipboardSetStorageItems(DataPackageOperation.Copy, [file]);
                InfoBar.Success("已复制", null, 3000);
            }
            else
            {
                InfoBar.Warning("文件不存在，需要重新合成", null, 5000);
            }
        }
        catch (Exception ex)
        {
            InfoBar.Warning("复制失败", ex.Message, 5000);
        }
    }



    [RelayCommand]
    private async Task SaveAsAsync()
    {
        try
        {
            if (_encodedJpegBytes is not null)
            {
                string name = _encodedJpegName ?? $"{DateTimeOffset.Now.ToUnixTimeSeconds()}.jpg";
                var picker = new FileSavePicker(this.XamlRoot.ContentIslandEnvironment.AppWindowId);
                picker.FileTypeChoices.Add("JPEG Image", [".jpg"]);
                picker.DefaultFileExtension = ".jpg";
                picker.SuggestedFileName = name;
                var fileResult = await picker.PickSaveFileAsync();
                if (fileResult is null)
                {
                    return;
                }
                string path = fileResult.Path;
                await File.WriteAllBytesAsync(path, _encodedJpegBytes);
                var file = await StorageFile.GetFileFromPathAsync(path);
                var options = new FolderLauncherOptions();
                options.ItemsToSelect.Add(file);
                await Launcher.LaunchFolderAsync(await file.GetParentAsync(), options);
            }
            else
            {
                InfoBar.Warning("文件不存在，需要重新合成", null, 5000);
            }
        }
        catch (UnauthorizedAccessException ex)
        {
            InfoBar.Error("保存失败，无写入权限", ex.Message);
        }
        catch (Exception ex)
        {
            InfoBar.Error("保存失败", ex.Message);
        }
    }



    [RelayCommand]
    private void CheckResult()
    {
        try
        {
            if (_encodedJpegBytes is not null)
            {
                string name = _encodedJpegName ?? $"{DateTimeOffset.Now.ToUnixTimeSeconds()}.jpg";
                MainWindow.Current.CheckResult(_encodedJpegBytes, name);
            }
            else
            {
                InfoBar.Warning("文件不存在，需要重新合成", null, 5000);
            }
        }
        catch { }
    }




    #endregion



}



