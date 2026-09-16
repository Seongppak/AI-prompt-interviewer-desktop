using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal sealed class InterceptTestForm : Form
{
    private readonly TextBox input = new TextBox();
    private readonly Button send = new Button();
    private bool submitted;
    private readonly string mode;

    internal InterceptTestForm(string mode)
    {
        this.mode = mode;
        Text = "AIPI Intercept Test Target";
        Width = 520;
        Height = 180;
        StartPosition = FormStartPosition.CenterScreen;
        TopMost = true;

        input.Left = 20;
        input.Top = 20;
        input.Width = 460;
        input.Text = mode.Contains("click") ? "클릭 가로채기 테스트" : "엔터 가로채기 테스트";
        Controls.Add(input);

        send.Left = 360;
        send.Top = 60;
        send.Width = 120;
        send.Text = "Send message";
        send.AccessibleName = "Send message";
        send.Click += delegate { submitted = true; };
        Controls.Add(send);
        AcceptButton = send;
        // WinForms의 기본 AcceptButton은 Ctrl/Alt+Enter를 전송으로 처리하지 않는다.
        // 실제 AI 채팅처럼 우회 단축키도 전송하도록 테스트 입력란을 구성한다.
        input.KeyDown += delegate(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && (e.Control || e.Alt))
            {
                submitted = true;
                e.SuppressKeyPress = true;
            }
        };

        Shown += delegate
        {
            Activate();
            BringToFront();
            SetForegroundWindow(Handle);
            input.Focus();
            Timer trigger = new Timer();
            trigger.Interval = 500;
            trigger.Tick += delegate
            {
                trigger.Stop();
                Activate();
                BringToFront();
                SetForegroundWindow(Handle);
                input.Focus();
                if (GetForegroundWindow() != Handle)
                {
                    Console.WriteLine("focus-failed");
                    Environment.ExitCode = 7;
                    Close();
                    return;
                }
                // 입력을 보내는 동안 UI 스레드가 UI Automation 조회에 응답해야 한다.
                System.Threading.ThreadPool.QueueUserWorkItem(delegate
                {
                    if (this.mode.Contains("click"))
                    {
                        ClickSendButton();
                        if (this.mode == "double-click") ClickSendButton();
                    }
                    else
                    {
                        if (this.mode == "ctrl-enter") keybd_event(0x11, 0, 0, UIntPtr.Zero);
                        if (this.mode == "alt-enter") keybd_event(0x12, 0, 0, UIntPtr.Zero);
                        PressEnter();
                        if (this.mode == "double-enter") PressEnter();
                        if (this.mode == "ctrl-enter") keybd_event(0x11, 0, 0x0002, UIntPtr.Zero);
                        if (this.mode == "alt-enter") keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);
                    }
                });
            };
            trigger.Start();

            Timer finish = new Timer();
            finish.Interval = 1500;
            finish.Tick += delegate
            {
                finish.Stop();
                Console.WriteLine(submitted ? "submitted" : "blocked");
                Environment.ExitCode = submitted ? 5 : 0;
                Close();
            };
            finish.Start();
        };
    }

    private void ClickSendButton()
    {
        RECT bounds;
        GetWindowRect(send.Handle, out bounds);
        SetCursorPos((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }

    private static void PressEnter()
    {
        keybd_event(0x0D, 0, 0, UIntPtr.Zero);
        keybd_event(0x0D, 0, 0x0002, UIntPtr.Zero);
    }

    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int left, top, right, bottom; }
}

internal static class AIPIInterceptTest
{
    [STAThread]
    private static void Main(string[] args)
    {
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new InterceptTestForm(args.Length > 0 ? args[0] : "enter"));
    }

    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
}
