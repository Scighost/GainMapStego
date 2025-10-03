using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.Windows.Storage.Pickers;
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Timers;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics.Imaging;
using Windows.Storage;


namespace GainMapStego;

[ObservableObject]
public sealed partial class MainWindow : Window
{


    public static new MainWindow Current { get; private set; }

    public string Version => typeof(MainWindow).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";


    private Timer _gcTimer = new(TimeSpan.FromSeconds(10));


    public MainWindow()
    {
        Current = this;
        InitializeComponent();
        SetIcon();
        this.ExtendsContentIntoTitleBar = true;
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        _gcTimer.Elapsed += (_, _) => GC.Collect();
        _gcTimer.Start();
    }



    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf8)]
    private static partial IntPtr GetModuleHandleA(string? lpModuleName);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf8)]
    private static partial IntPtr LoadIconA(IntPtr hInstance, string lpIconName);


    private async void SetIcon()
    {
        nint hInstance = GetModuleHandleA(null);
        nint hIcon = LoadIconA(hInstance, "#32512");
        AppWindow.SetIcon(Win32Interop.GetIconIdFromIcon(hIcon));
        using var stream = typeof(MainWindow).Assembly.GetManifestResourceStream("GainMapStego.favicon.ico");
        var bitmap = new BitmapImage();
        await bitmap.SetSourceAsync(stream.AsRandomAccessStream());
        Image_Icon.Source = bitmap;
    }



    public int PageSelectedIndex { get; set => SetProperty(ref field, value); }



    private void DisplayContent()
    {
        Border_ContentCorner.Visibility = Visibility.Visible;
        Pivot_EncodeDecode.Visibility = Visibility.Visible;
        Segmented_EncodeDecode.Visibility = Visibility.Visible;
        Grid_Welcome.Visibility = Visibility.Collapsed;
    }




    [RelayCommand]
    private void OpenEncodePage()
    {
        DisplayContent();
        PageSelectedIndex = 0;
    }




    [RelayCommand]
    private async Task OpenFileAsync()
    {
        try
        {
            var picker = new FileOpenPicker(this.AppWindow.Id);
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
                using var fs = File.OpenRead(fileResult.Path);
                _ = await BitmapDecoder.CreateAsync(fs.AsRandomAccessStream());
                DisplayContent();
                await Task.Delay(100);
                PageSelectedIndex = 1;
                _ = Page_Decode.OpenFileAsync(fileResult.Path);
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
    }



    private void Grid_Welcome_DragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            e.AcceptedOperation = DataPackageOperation.Copy;
            Border_DragOver.Opacity = 1;
        }
    }

    private void Grid_Welcome_DragLeave(object sender, DragEventArgs e)
    {
        Border_DragOver.Opacity = 0;
    }



    private async void Grid_Welcome_Drop(object sender, DragEventArgs e)
    {
        Border_DragOver.Opacity = 0;
        var defer = e.GetDeferral();
        try
        {
            var items = await e.DataView.GetStorageItemsAsync();
            if (items.Where(x => x.IsOfType(StorageItemTypes.File)).Cast<StorageFile>().FirstOrDefault() is StorageFile file)
            {
                using var fs = await file.OpenReadAsync();
                _ = await BitmapDecoder.CreateAsync(fs);
                DisplayContent();
                await Task.Delay(100);
                PageSelectedIndex = 1;
                _ = Page_Decode.OpenFileAsync(file);
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



    public void CheckResult(byte[] bytes, string name)
    {
        PageSelectedIndex = 1;
        Page_Decode.LoadImage(bytes, name);
    }



}
