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
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
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
public sealed partial class DecodePage : Page
{

    private const string BaseImageName = "基础图";

    private const string GainmapImageName = "增益图";

    private const string AlternateImageName = "合成图";


    private const float MAX_ZOOM_FACTOR = 5f;

    private float DisplayScale => XamlRoot?.ContentIslandEnvironment?.DisplayScale ?? 1;

    public DecodePage()
    {
        InitializeComponent();
        ScrollViewer_Image.SetArePointerWheelEventsIgnored(true);
    }


    public ObservableCollection<ImageInfo> ImageInfos { get; set; } = new();

    public ImageInfo? SelectedImageInfo
    {
        get; set
        {
            if (SetProperty(ref field, value))
            {
                AdjustImageSize(value);
            }
        }
    }

    public bool IsDecoding { get; set => SetProperty(ref field, value); }

    public string Error { get; set => SetProperty(ref field, value); }


    private string? _imageFileName;



    #region Drag and Drop


    private void RootGrid_DragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            e.AcceptedOperation = DataPackageOperation.Copy;
            Border_DragOver.Opacity = 1;
        }
    }


    private void RootGrid_DragLeave(object sender, DragEventArgs e)
    {
        Border_DragOver.Opacity = 0;
    }


    private async void RootGrid_Drop(object sender, DragEventArgs e)
    {
        Border_DragOver.Opacity = 0;
        var defer = e.GetDeferral();
        try
        {
            var items = await e.DataView.GetStorageItemsAsync();
            if (items.Where(x => x.IsOfType(StorageItemTypes.File)).Cast<StorageFile>().FirstOrDefault() is StorageFile file)
            {
                _imageFileName = file.Name;
                if (string.IsNullOrWhiteSpace(_imageFileName))
                {
                    _imageFileName = DateTimeOffset.Now.ToUnixTimeSeconds().ToString();
                }
                using var stream = await file.OpenReadAsync();
                byte[] bytes = new byte[stream.Size];
                await stream.AsStream().ReadExactlyAsync(bytes);
                _ = LoadImageAsync(bytes);
            }
        }
        catch (Exception ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
        finally
        {
            defer.Complete();
        }
    }


    #endregion




    [RelayCommand]
    private async Task OpenFileAsync()
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
                _imageFileName = Path.GetFileName(fileResult.Path);
                byte[] bytes = await File.ReadAllBytesAsync(fileResult.Path);
                _ = LoadImageAsync(bytes);
            }
        }
        catch (Exception ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
    }


    public async Task OpenFileAsync(string path)
    {
        try
        {
            _imageFileName = Path.GetFileName(path);
            byte[] bytes = await File.ReadAllBytesAsync(path);
            _ = LoadImageAsync(bytes);
        }
        catch (Exception ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
    }


    public async Task OpenFileAsync(StorageFile file)
    {
        try
        {
            _imageFileName = file.Name;
            using var fs = await file.OpenReadAsync();
            byte[] bytes = new byte[fs.Size];
            await fs.AsStream().ReadExactlyAsync(bytes);
            _ = LoadImageAsync(bytes);
        }
        catch (Exception ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
    }


    public void LoadImage(byte[] bytes, string name)
    {
        try
        {
            _imageFileName = name;
            _ = LoadImageAsync(bytes);
        }
        catch (Exception ex)
        {
            InfoBar.Error("打开文件失败", ex.Message);
        }
    }


    public async Task LoadImageAsync(byte[] bytes)
    {
        try
        {
            IsDecoding = true;
            (var baseImage, var baseThumb) = await GetWriteableBitmapAsync(bytes);
            string fileSize = Helper.GetFileSizeText(bytes.Length);
            ResetImageSource();
            var baseImageInfo = new ImageInfo
            {
                Title = BaseImageName,
                Source = baseImage,
                Thumbnail = baseThumb,
                FileSize = fileSize,
                PixelSize = $"{baseImage.PixelWidth} x {baseImage.PixelHeight}",
                Width = baseImage.PixelWidth,
                Height = baseImage.PixelHeight,
                EncodedBytes = bytes,
            };
            ImageInfos.Add(baseImageInfo);
            OnImageOpened();
            await Task.Delay(1);

            if (UhdrCodec.IsUhdrImage(bytes))
            {
                using var decoder = UhdrDecoder.Create(bytes, true);
                decoder.SetOutColorTransfer(UhdrColorTransfer.Linear);
                decoder.SetOutImagePixelFormat(UhdrPixelFormat._64bppRGBAHalfFloat);
                await Task.Run(decoder.Decode);
                baseImageInfo.EncodedBytes = decoder.GetBaseImage().ToArray();

                var metadata = decoder.GetGainmapMetadata();

                using var floatImage = new CanvasRenderTarget(CanvasDevice.GetSharedDevice(), decoder.ImageWidth, decoder.ImageHeight, 96, DirectXPixelFormat.R16G16B16A16Float, CanvasAlphaMode.Premultiplied);
                floatImage.SetPixelBytes(decoder.GetDecodedImage().AsSpan(0).ToArray());
                using var renderTarget = new CanvasRenderTarget(CanvasDevice.GetSharedDevice(), decoder.ImageWidth, decoder.ImageHeight, 96, DirectXPixelFormat.B8G8R8A8UIntNormalized, CanvasAlphaMode.Premultiplied);
                using (var ds = renderTarget.CreateDrawingSession())
                {
                    using var effect = new SrgbGammaEffect
                    {
                        Source = floatImage,
                        GammaMode = SrgbGammaMode.OETF,
                        BufferPrecision = CanvasBufferPrecision.Precision16Float,
                    };
                    ds.DrawImage(effect);
                }
                var alternateImage = new WriteableBitmap(decoder.ImageWidth, decoder.ImageHeight);
                renderTarget.GetPixelBytes().CopyTo(alternateImage.PixelBuffer);
                var thumbHeight = (int)(140 * DisplayScale);
                ImageSource alternateThumb;
                if (decoder.ImageHeight <= thumbHeight)
                {
                    alternateThumb = alternateImage;
                }
                else
                {
                    int thumbWidth = decoder.ImageWidth * thumbHeight / decoder.ImageHeight;
                    var source = new CanvasImageSource(CanvasDevice.GetSharedDevice(), thumbWidth, thumbHeight, 96, CanvasAlphaMode.Premultiplied);
                    using var ds = source.CreateDrawingSession(Colors.Transparent);
                    ds.DrawImage(renderTarget, new Rect(0, 0, thumbWidth, thumbHeight), new Rect(0, 0, alternateImage.PixelWidth, alternateImage.PixelHeight), 1, CanvasImageInterpolation.HighQualityCubic);
                    alternateThumb = source;
                }
                ImageInfos.Add(new ImageInfo
                {
                    Title = AlternateImageName,
                    Source = alternateImage,
                    Thumbnail = alternateThumb,
                    FileSize = fileSize,
                    PixelSize = $"{decoder.ImageWidth} x {decoder.ImageHeight}",
                    Width = decoder.ImageWidth,
                    Height = decoder.ImageHeight,
                });
                await Task.Delay(1);

                var gainmapBytes = decoder.GetGainmapImage().ToArray();
                (var gainmapImage, var gainmapThumb) = await GetWriteableBitmapAsync(gainmapBytes);
                ImageInfos.Add(new ImageInfo
                {
                    Title = GainmapImageName,
                    Source = gainmapImage,
                    Thumbnail = gainmapThumb,
                    FileSize = fileSize,
                    PixelSize = $"{gainmapImage.PixelWidth} x {gainmapImage.PixelHeight}",
                    Width = gainmapImage.PixelWidth,
                    Height = gainmapImage.PixelHeight,
                    EncodedBytes = gainmapBytes,
                });
            }
        }
        catch (Exception ex)
        {
            InfoBar.Error("解码失败", ex.Message);
        }
        finally
        {
            IsDecoding = false;
        }
    }


    private async Task<(WriteableBitmap, ImageSource)> GetWriteableBitmapAsync(byte[] bytes)
    {
        using var ms = new MemoryStream(bytes).AsRandomAccessStream();
        var decoder = await BitmapDecoder.CreateAsync(ms);
        using var softwareBitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        var bitmap = new WriteableBitmap((int)decoder.PixelWidth, (int)decoder.PixelHeight);
        softwareBitmap.CopyToBuffer(bitmap.PixelBuffer);
        int thumbHeight = (int)(140 * DisplayScale);
        if (softwareBitmap.PixelHeight <= thumbHeight)
        {
            return (bitmap, bitmap);
        }
        int thumbWidth = softwareBitmap.PixelWidth * thumbHeight / softwareBitmap.PixelHeight;
        using var canvasBitmap = CanvasBitmap.CreateFromSoftwareBitmap(CanvasDevice.GetSharedDevice(), softwareBitmap);
        var thumbnail = new CanvasImageSource(CanvasDevice.GetSharedDevice(), thumbWidth, thumbHeight, 96, CanvasAlphaMode.Premultiplied);
        using (var ds = thumbnail.CreateDrawingSession(Colors.Transparent))
        {
            ds.DrawImage(canvasBitmap, new Rect(0, 0, thumbWidth, thumbHeight), new Rect(0, 0, bitmap.PixelWidth, bitmap.PixelHeight), 1, CanvasImageInterpolation.HighQualityCubic);
        }
        return (bitmap, thumbnail);
    }



    private void ResetImageSource()
    {
        ImageInfos.Clear();
    }


    private void AdjustImageSize(ImageInfo? info)
    {
        if (info is not null)
        {
            DiaplayImage.Width = info.Width / DisplayScale;
            DiaplayImage.Height = info.Height / DisplayScale;
        }
        else
        {
            DiaplayImage.Width = double.NaN;
            DiaplayImage.Height = double.NaN;
        }
    }


    private void OnImageOpened()
    {
        ListView_ImageInfos.SelectedIndex = 0;
        Grid_ImageInfo.Visibility = Visibility.Visible;
        Grid_ButtomImageInfo.Visibility = Visibility.Visible;
        ResetZoomFactor();
    }



    private async void MenuFlyoutItem_Copy_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (sender is FrameworkElement { DataContext: ImageInfo info })
            {
                string suffix = info.Title switch
                {
                    BaseImageName => "_base",
                    GainmapImageName => "_gainmap",
                    AlternateImageName => "_alternate",
                    _ => "",
                };
                string name = $"{Path.GetFileNameWithoutExtension(_imageFileName)}{suffix}{Path.GetExtension(_imageFileName)}";
                string path = Path.Combine(Helper.GetOutputFolder(), name);
                info.EncodedBytes ??= await Helper.EncodeAsJpegAsync(info.Source);
                await File.WriteAllBytesAsync(path, info.EncodedBytes);
                var file = await StorageFile.GetFileFromPathAsync(path);
                Helper.ClipboardSetStorageItems(DataPackageOperation.Copy, file);
                InfoBar.Success("已复制到剪贴板", null, 3000);
            }
        }
        catch (Exception ex)
        {
            InfoBar.Error("复制失败", ex.Message);
        }
    }


    private async void MenuFlyoutItem_SaveAs_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (sender is FrameworkElement { DataContext: ImageInfo info })
            {
                string suffix = info.Title switch
                {
                    BaseImageName => "_base",
                    GainmapImageName => "_gainmap",
                    AlternateImageName => "_alternate",
                    _ => "",
                };
                string name = $"{Path.GetFileNameWithoutExtension(_imageFileName)}{suffix}{Path.GetExtension(_imageFileName)}";
                var picker = new FileSavePicker(this.XamlRoot.ContentIslandEnvironment.AppWindowId);
                picker.FileTypeChoices.Add("JPEG Image", new string[] { ".jpg" });
                picker.FileTypeChoices.Add("所有文件", ["*"]);
                picker.DefaultFileExtension = ".jpg";
                picker.SuggestedFileName = name;
                var fileResult = await picker.PickSaveFileAsync();
                if (fileResult is null)
                {
                    return;
                }
                string path = fileResult.Path;

                info.EncodedBytes ??= await Helper.EncodeAsJpegAsync(info.Source);
                await File.WriteAllBytesAsync(path, info.EncodedBytes);
                var file = await StorageFile.GetFileFromPathAsync(path);
                var options = new FolderLauncherOptions();
                options.ItemsToSelect.Add(file);
                await Launcher.LaunchFolderAsync(await file.GetParentAsync(), options);
            }
        }
        catch (Exception ex)
        {
            InfoBar.Error("保存失败", ex.Message);
        }
    }



    #region Zoom



    private bool _canImageMoved;

    private Point _imageMoveOldPosition;


    private void ScrollViewer_Image_PointerPressed(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
    {
        _canImageMoved = true;
        ScrollViewer_Image.CapturePointer(e.Pointer);
        _imageMoveOldPosition = e.GetCurrentPoint(ScrollViewer_Image).Position;
    }


    private void ScrollViewer_Image_PointerMoved(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
    {
        if (_canImageMoved)
        {
            var point = e.GetCurrentPoint(ScrollViewer_Image);
            if (point.Properties.IsLeftButtonPressed)
            {
                var deltaX = point.Position.X - _imageMoveOldPosition.X;
                var deltaY = point.Position.Y - _imageMoveOldPosition.Y;
                _imageMoveOldPosition = point.Position;
                ScrollViewer_Image.ChangeView(ScrollViewer_Image.HorizontalOffset - deltaX, ScrollViewer_Image.VerticalOffset - deltaY, null, true);
            }
        }
    }


    private void ScrollViewer_Image_PointerReleased(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
    {
        _canImageMoved = false;
        ScrollViewer_Image.ReleasePointerCapture(e.Pointer);
    }


    private void ScrollViewer_Image_DoubleTapped(object sender, Microsoft.UI.Xaml.Input.DoubleTappedRoutedEventArgs e)
    {
        try
        {
            float oldFactor = ScrollViewer_Image.ZoomFactor;
            float? fitFactor = GetFitZoomFactor();
            float? newFactor = null;
            if (fitFactor.HasValue && fitFactor < 1)
            {
                newFactor = oldFactor switch
                {
                    < 0.4f => oldFactor * 2,
                    < 0.9999f => 1,
                    _ => fitFactor,
                };
            }
            else if (fitFactor.HasValue && fitFactor >= 1)
            {
                newFactor = oldFactor switch
                {
                    > 0.9999f and < 1.0001f => fitFactor,
                    _ => 1,
                };
            }
            if (newFactor.HasValue)
            {
                Zoom(newFactor.Value, e.GetPosition(ScrollViewer_Image));
            }
        }
        catch { }
    }


    private void ScrollViewer_Image_PointerWheelChanged(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
    {
        try
        {
            var point = e.GetCurrentPoint(ScrollViewer_Image);
            int delta = point.Properties.MouseWheelDelta;
            float factor = ScrollViewer_Image.ZoomFactor;
            Zoom(delta > 0 ? factor * 1.2f : factor * 0.8f, point.Position);
        }
        catch { }
    }


    private void Slider_ZoomFactor_ManipulationDelta(object sender, Microsoft.UI.Xaml.Input.ManipulationDeltaRoutedEventArgs e)
    {
        Zoom(Slider_ZoomFactor.Value, null);
    }


    private void Button_ZoomToFitFactor_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            float? fitFactor = GetFitZoomFactor();
            if (fitFactor.HasValue)
            {
                if (MathF.Abs(fitFactor.Value - ScrollViewer_Image.ZoomFactor) < 0.0001f)
                {
                    Zoom(1);
                }
                else
                {
                    Zoom(fitFactor.Value);
                }
            }
        }
        catch { }
    }


    private void Button_ZoomOut_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            float oldFactor = ScrollViewer_Image.ZoomFactor;
            float newFactor = oldFactor switch
            {
                > 2.0001f => oldFactor - 0.2501f,
                _ => oldFactor - 0.1001f,
            };
            newFactor = newFactor switch
            {
                > 2.0001f => MathF.Ceiling(newFactor * 4) / 4,
                _ => MathF.Ceiling(newFactor * 10) / 10,
            };
            Zoom(newFactor, null);
        }
        catch { }
    }


    private void Button_ZoomIn_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            float oldFactor = ScrollViewer_Image.ZoomFactor;
            float newFactor = oldFactor switch
            {
                < 1.9999f => oldFactor + 0.1001f,
                _ => oldFactor + 0.2501f,
            };
            newFactor = newFactor switch
            {
                < 2f => MathF.Floor(newFactor * 10) / 10,
                _ => MathF.Floor(newFactor * 4) / 4,
            };
            Zoom(newFactor, null);
        }
        catch { }
    }


    private float? GetFitZoomFactor()
    {
        double scrollWidth = ScrollViewer_Image.ActualWidth;
        double scrollHeight = ScrollViewer_Image.ActualHeight;
        double imageWidth = DiaplayImage.ActualWidth;
        double imageHeight = DiaplayImage.ActualHeight;
        if (scrollWidth == 0 || scrollHeight == 0 || imageWidth == 0 || imageHeight == 0)
        {
            return null;
        }
        return (float)Math.Min(scrollWidth / imageWidth, scrollHeight / imageHeight);
    }


    private void ResetZoomFactor()
    {
        try
        {
            ScrollViewer_Image.UpdateLayout();
            float? fitFactor = GetFitZoomFactor();
            if (fitFactor.HasValue)
            {
                ScrollViewer_Image.ZoomToFactor(MathF.Min(fitFactor.Value, 1));
            }
        }
        catch { }
    }


    private void Zoom(double factor, Point? centerPoint = null)
    {
        try
        {
            double new_factor = Math.Clamp(factor, 0.1, MAX_ZOOM_FACTOR);
            double old_factor = ScrollViewer_Image.ZoomFactor;
            if (new_factor == old_factor)
            {
                return;
            }
            double offset_x = ScrollViewer_Image.HorizontalOffset;
            double offset_y = ScrollViewer_Image.VerticalOffset;
            double viewport_width = ScrollViewer_Image.ViewportWidth;
            double viewport_height = ScrollViewer_Image.ViewportHeight;
            double extent_width = ScrollViewer_Image.ExtentWidth;
            double extent_height = ScrollViewer_Image.ExtentHeight;

            double fictor_scale = new_factor / old_factor;
            double fit_factor = GetFitZoomFactor() ?? 1;
            if (new_factor <= fit_factor)
            {
                ScrollViewer_Image.ChangeView(0, 0, (float)new_factor);
                return;
            }

            Rect image_rect = new Rect(extent_width < viewport_width ? ((viewport_width - extent_width) / 2) : -offset_x,
                                       extent_height < viewport_height ? ((viewport_height - extent_height) / 2) : -offset_y,
                                       extent_width, extent_height);

            if (!centerPoint.HasValue || !image_rect.Contains(centerPoint.Value))
            {
                centerPoint = new Point(viewport_width / 2, viewport_height / 2);
            }

            Rect image_rect_new = new Rect();
            image_rect_new.X = (image_rect.X - centerPoint.Value.X) * fictor_scale + centerPoint.Value.X;
            image_rect_new.Y = (image_rect.Y - centerPoint.Value.Y) * fictor_scale + centerPoint.Value.Y;
            image_rect_new.Width = image_rect.Width * fictor_scale;
            image_rect_new.Height = image_rect.Height * fictor_scale;

            double offset_x_new = -image_rect_new.X;
            double offset_y_new = -image_rect_new.Y;
            ScrollViewer_Image.ChangeView(offset_x_new, offset_y_new, (float)new_factor);
        }
        catch { }
    }



    #endregion


}



public class ImageInfo : ObservableObject
{
    public string Title { get; set; }

    public WriteableBitmap Source { get; set; }

    public ImageSource Thumbnail { get; set; }

    public string FileSize { get; set; }

    public string PixelSize { get; set; }

    public int Width { get; set; }

    public int Height { get; set; }

    public byte[]? EncodedBytes { get; set; }

}
