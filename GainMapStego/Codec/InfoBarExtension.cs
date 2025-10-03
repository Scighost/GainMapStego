using Microsoft.UI.Xaml.Controls;
using System.Threading.Tasks;

namespace GainMapStego;

public static class InfoBarExtension
{

    public static async void Info(this InfoBar infoBar, string? title, string? message, int time = 0)
    {
        infoBar.Title = title;
        infoBar.Message = message;
        infoBar.Severity = InfoBarSeverity.Informational;
        infoBar.IsOpen = true;
        if (time > 0)
        {
            await Task.Delay(time);
            infoBar.IsOpen = false;
        }
    }

    public static async void Success(this InfoBar infoBar, string? title, string? message, int time = 0)
    {
        infoBar.Title = title;
        infoBar.Message = message;
        infoBar.Severity = InfoBarSeverity.Success;
        infoBar.IsOpen = true;
        if (time > 0)
        {
            await Task.Delay(time);
            infoBar.IsOpen = false;
        }
    }

    public static async void Warning(this InfoBar infoBar, string? title, string? message, int time = 0)
    {
        infoBar.Title = title;
        infoBar.Message = message;
        infoBar.Severity = InfoBarSeverity.Warning;
        infoBar.IsOpen = true;
        if (time > 0)
        {
            await Task.Delay(time);
            infoBar.IsOpen = false;
        }
    }

    public static async void Error(this InfoBar infoBar, string? title, string? message, int time = 0)
    {
        infoBar.Title = title;
        infoBar.Message = message;
        infoBar.Severity = InfoBarSeverity.Error;
        infoBar.IsOpen = true;
        if (time > 0)
        {
            await Task.Delay(time);
            infoBar.IsOpen = false;
        }
    }

}