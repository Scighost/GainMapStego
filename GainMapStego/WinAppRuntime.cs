using Microsoft.Windows.ApplicationModel.DynamicDependency;
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace GainMapStego;

/// <summary>
/// 在启动时初始化 Windows App Runtime（Bootstrap）。
/// 若本机未安装对应版本的 Windows App Runtime，则弹出任务对话框，
/// 自动从 aka.ms 下载安装器并以管理员权限安装，安装完成后自动重启应用。
/// </summary>
internal static partial class WinAppRuntime
{
    private const double MB = 1 << 20;

    /// <summary>
    /// Windows App SDK 2.3.1 的 majorMinorVersion（0x00020003 = 2.3）。
    /// 来源：microsoft.windowsappsdk.runtime/2.3.1 包内 WindowsAppSDK-VersionInfo.json
    /// </summary>
    private const uint MajorMinorVersion = 0x00020003;

    /// <summary>
    /// Windows App Runtime 2.3.1.0（框架包 Microsoft.WindowsAppRuntime.2 的版本，来自 MSIX AppxManifest.xml）。
    /// </summary>
    private const ulong MinVersion = 0x0002000300010000;

    /// <summary>
    /// Windows App Runtime 2.3.1 安装器下载地址（仅 x64）。
    /// 来源：https://learn.microsoft.com/windows/apps/windows-app-sdk/downloads
    /// </summary>
    private const string InstallerUrl = "https://aka.ms/windowsappsdk/2.3/2.3.1/windowsappruntimeinstall-x64.exe";

    /// <summary>
    /// 在 Main() 之前运行：尝试初始化 Windows App Runtime。
    /// 失败时弹出安装对话框，安装成功后重启应用。
    /// </summary>
    [ModuleInitializer]
    internal static void Initialize()
    {
        var minVersion = new PackageVersion(MinVersion);
        if (!Bootstrap.TryInitialize(MajorMinorVersion, "", minVersion, Bootstrap.InitializeOptions.None, out int hr))
        {
            new Installer().Install().GetAwaiter().GetResult();
            Environment.Exit(hr);
        }
    }


    private sealed class Installer
    {
        public long TotalBytes { get; set; }

        public long DownloadBytes { get; set; }

        public bool InstallSuccess { get; set; }

        private Task downloadTask = null!;

        /// <summary>根引用回调委托，防止 TaskDialogIndirect 期间被 GC 回收。</summary>
        private readonly TaskDialogCallback _callback;

        public Installer()
        {
            _callback = DialogCallback;
        }


        public async Task Install()
        {
            try
            {
                downloadTask = DownloadAndInstallAsync();

                int result = CreateDialog();
                if (result == 1001) // 手动下载
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = InstallerUrl,
                        UseShellExecute = true,
                    });
                }
                else if (result == 2) // 取消（IDCANCEL）
                {
                    return;
                }
                else // IDOK：安装完成，重启应用
                {
                    Process.Start(Environment.ProcessPath!);
                }
            }
            catch { }
        }


        private async Task DownloadAndInstallAsync()
        {
            try
            {
                string file = Path.GetTempFileName() + ".exe";

                for (int i = 0; i < 3; i++)
                {
                    try
                    {
                        using var fs = File.Open(file, FileMode.Create, FileAccess.ReadWrite);
                        using var client = new HttpClient();
                        var response = await client.GetAsync(InstallerUrl, HttpCompletionOption.ResponseHeadersRead);
                        response.EnsureSuccessStatusCode();
                        TotalBytes = response.Content.Headers.ContentLength ?? 0;
                        DownloadBytes = 0;
                        using var hs = await response.Content.ReadAsStreamAsync();
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = await hs.ReadAsync(buffer)) > 0)
                        {
                            await fs.WriteAsync(buffer.AsMemory(0, read));
                            DownloadBytes += read;
                        }
                        break;
                    }
                    catch (Exception)
                    {
                        if (i >= 2)
                        {
                            throw;
                        }
                    }
                }

                var p = Process.Start(new ProcessStartInfo
                {
                    FileName = file,
                    UseShellExecute = true,
                    Verb = "runas",
                });
                await p!.WaitForExitAsync();

                InstallSuccess = p.ExitCode is 0;
            }
            catch { }
        }


        private int CreateDialog()
        {
            var button = new TASKDIALOG_BUTTON { nButtonID = 1001, pszButtonText = Marshal.StringToHGlobalUni("手动下载") };
            GCHandle buttonHandle = GCHandle.Alloc(button, GCHandleType.Pinned);

            nint title = Marshal.StringToHGlobalUni("GainMapStego");
            nint instruction = Marshal.StringToHGlobalUni("需要安装 Windows App Runtime");
            nint content = Marshal.StringToHGlobalUni("正在下载 Windows App Runtime 运行时组件…\n");

            var config = new TASKDIALOGCONFIG
            {
                cbSize = (uint)Marshal.SizeOf<TASKDIALOGCONFIG>(),
                hwndParent = nint.Zero,
                dwFlags = TDF_USE_HICON_MAIN | TDF_SHOW_PROGRESS_BAR | TDF_CALLBACK_TIMER,
                dwCommonButtons = TDCBF_CANCEL_BUTTON,
                pszWindowTitle = title,
                pszMainIcon = LoadAppIcon(),
                pszMainInstruction = instruction,
                pszContent = content,
                cButtons = 1,
                pButtons = buttonHandle.AddrOfPinnedObject(),
                nDefaultButton = 1001,
                pfCallback = Marshal.GetFunctionPointerForDelegate(_callback),
            };

            try
            {
                TaskDialogIndirect(ref config, out int result, out _, out _);
                return result;
            }
            finally
            {
                buttonHandle.Free();
                Marshal.FreeHGlobal(title);
                Marshal.FreeHGlobal(instruction);
                Marshal.FreeHGlobal(content);
            }
        }


        private int DialogCallback(nint hwnd, uint msg, nint wParam, nint lParam, nint refData)
        {
            switch (msg)
            {
                case TDN_TIMER:
                    if (downloadTask.IsCompleted)
                    {
                        if (InstallSuccess)
                        {
                            SendMessage(hwnd, TDM_CLICK_BUTTON, (nint)1, nint.Zero);
                        }
                        else
                        {
                            SetContentText(hwnd, "下载或安装失败，请重试或手动下载。\n");
                        }
                    }
                    else
                    {
                        if (TotalBytes > 0)
                        {
                            SendMessage(hwnd, TDM_SET_PROGRESS_BAR_POS, (nint)(DownloadBytes * 100 / TotalBytes), nint.Zero);
                            SetContentText(hwnd, $"正在下载 Windows App Runtime 运行时组件…\n{DownloadBytes / MB:F2} / {TotalBytes / MB:F2} MB");
                        }
                        else if (DownloadBytes > 0)
                        {
                            SetContentText(hwnd, $"正在下载 Windows App Runtime 运行时组件…\n{DownloadBytes / MB:F2} MB");
                        }
                        else
                        {
                            SetContentText(hwnd, "正在下载 Windows App Runtime 运行时组件…\n");
                        }
                    }
                    break;
                default:
                    break;
            }
            return 0;
        }


        /// <summary>
        /// 更新任务对话框内容文本（SendMessage 同步处理，处理完成后可安全释放字符串）。
        /// </summary>
        private static void SetContentText(nint hwnd, string text)
        {
            nint p = Marshal.StringToHGlobalUni(text);
            SendMessage(hwnd, TDM_SET_ELEMENT_TEXT, (nint)TDE_CONTENT, p);
            Marshal.FreeHGlobal(p);
        }


        private static nint LoadAppIcon()
        {
            nint hInstance = GetModuleHandleW(null);
            return LoadIconW(hInstance, "#32512");
        }
    }


    // ===================== TaskDialogIndirect (ComCtl32) P/Invoke =====================

    private const uint TDF_USE_HICON_MAIN = 0x00000002;
    private const uint TDF_SHOW_PROGRESS_BAR = 0x00000040;
    private const uint TDF_CALLBACK_TIMER = 0x00000200;
    private const uint TDCBF_CANCEL_BUTTON = 0x00000008;

    private const uint TDN_TIMER = 5;
    private const uint TDM_CLICK_BUTTON = 0x0406;
    private const uint TDM_SET_PROGRESS_BAR_POS = 0x0403;
    private const uint TDM_SET_ELEMENT_TEXT = 0x0404;
    private const uint TDE_CONTENT = 1;


    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TASKDIALOG_BUTTON
    {
        public int nButtonID;
        public nint pszButtonText;
    }


    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TASKDIALOGCONFIG
    {
        public uint cbSize;
        public nint hwndParent;
        public nint hInstance;
        public uint dwFlags;
        public uint dwCommonButtons;
        public nint pszWindowTitle;
        public nint pszMainIcon;
        public nint pszMainInstruction;
        public nint pszContent;
        public uint cButtons;
        public nint pButtons;
        public int nDefaultButton;
        public uint cRadioButtons;
        public nint pRadioButtons;
        public nint pszVerificationText;
        public nint pszExpandedInformation;
        public nint pszExpandedControlText;
        public nint pszCollapsedControlText;
        public nint pszFooterIcon;
        public nint pszFooter;
        public nint pfCallback;
        public nint lpCallbackData;
        public uint cxWidth;
    }


    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int TaskDialogCallback(nint hwnd, uint msg, nint wParam, nint lParam, nint refData);


    [LibraryImport("comctl32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int TaskDialogIndirect(ref TASKDIALOGCONFIG pTaskConfig, out int pnButton, out int pnRadioButton, [MarshalAs(UnmanagedType.Bool)] out bool pfVerificationFlagChecked);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint SendMessage(nint hWnd, uint Msg, nint wParam, nint lParam);

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint GetModuleHandleW(string? lpModuleName);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint LoadIconW(nint hInstance, string lpIconName);
}
