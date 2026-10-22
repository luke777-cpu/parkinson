using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
class Launcher {
    [STAThread]
    static int Main(string[] args) {
        bool created;
        using (Mutex mutex=new Mutex(true,"Local\\ParkinsonLifeManagerDiaryExperimentDesktop",out created)) {
        if(!created) { MessageBox.Show("이미 실행 중입니다. 열려 있는 Parkinson Life Manager 창을 확인하세요.","Parkinson Life Manager"); return 0; }
        string root=AppDomain.CurrentDomain.BaseDirectory;
        ProcessStartInfo p=new ProcessStartInfo(Path.Combine(root,"runtime","python.exe"));
        p.Arguments="\""+Path.Combine(root,Array.IndexOf(args,"--demo")>=0?"demo.py":"app.py")+"\" --desktop";
        if(Array.IndexOf(args,"--no-browser")>=0) p.Arguments+=" --no-browser";
        p.WorkingDirectory=root; p.UseShellExecute=false; p.CreateNoWindow=true;
        p.RedirectStandardError=true; p.RedirectStandardOutput=true;
        try { using(Process proc=Process.Start(p)) {
            proc.OutputDataReceived+=(s,e)=>{};proc.BeginOutputReadLine();
            string error=proc.StandardError.ReadToEnd();proc.WaitForExit();
            if(proc.ExitCode!=0) MessageBox.Show("실행 중 문제가 발생했습니다. 기존 앱을 종료한 뒤 다시 실행하세요.\n\n"+error,"Parkinson Life Manager");
            return proc.ExitCode;
        } }
        catch(Exception e) { MessageBox.Show(e.Message,"Parkinson Life Manager"); return 1; }
        }
    }
}
