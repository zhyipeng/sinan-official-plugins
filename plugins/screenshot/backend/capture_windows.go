package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"unicode/utf16"
)

func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
func powershell(ctx context.Context, script string) *exec.Cmd {
	units := utf16.Encode([]rune(script))
	data := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(data[i*2:], u)
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	cmd := exec.CommandContext(ctx, root+`\System32\WindowsPowerShell\v1.0\powershell.exe`, "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", base64.StdEncoding.EncodeToString(data))
	configureProcess(cmd)
	return cmd
}
func capturePlatform(ctx context.Context, path string) error {
	cmd := powershell(ctx, selectorScript)
	cmd.Env = append(os.Environ(), "SINAN_CAPTURE_OUTPUT="+path)
	if err := cmd.Run(); err != nil {
		return errors.New("截图已取消、超时或 Windows 图形服务不可用")
	}
	return nil
}

// Capture before showing the overlay; virtual screen coordinates include negative origins.
const selectorScript = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class SinanSelector : Form {
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 Bitmap desktop; Point origin; Rectangle region; bool dragging;
 public static void Run(string path) {
  try {if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) SetProcessDPIAware();} catch(EntryPointNotFoundException) {SetProcessDPIAware();}
  var bounds=SystemInformation.VirtualScreen;
  if((long)bounds.Width*bounds.Height>32000000) throw new InvalidOperationException("Screen exceeds capture pixel budget");
  using(var image=new Bitmap(bounds.Width,bounds.Height)) {
   using(var g=Graphics.FromImage(image)) {g.CopyFromScreen(bounds.Location,Point.Empty,bounds.Size);}
   using(var form=new SinanSelector(image,bounds)) {
    if(form.ShowDialog()!=DialogResult.OK || form.region.Width<2 || form.region.Height<2) return;
    using(var cropped=image.Clone(form.region,PixelFormat.Format32bppArgb)) {cropped.Save(path,ImageFormat.Png);}
   }
  }
 }
 SinanSelector(Bitmap image,Rectangle bounds) {
  desktop=image;FormBorderStyle=FormBorderStyle.None;StartPosition=FormStartPosition.Manual;Bounds=bounds;TopMost=true;ShowInTaskbar=false;KeyPreview=true;DoubleBuffered=true;AutoScaleMode=AutoScaleMode.None;Cursor=Cursors.Cross;
  KeyDown+=(s,e)=>{if(e.KeyCode==Keys.Escape){DialogResult=DialogResult.Cancel;Close();}};
  MouseDown+=(s,e)=>{if(e.Button==MouseButtons.Right){Close();return;}if(e.Button!=MouseButtons.Left)return;origin=e.Location;dragging=true;Capture=true;};
  MouseMove+=(s,e)=>{if(!dragging)return;region=Rectangle.FromLTRB(Math.Min(origin.X,e.X),Math.Min(origin.Y,e.Y),Math.Max(origin.X,e.X),Math.Max(origin.Y,e.Y));region.Intersect(ClientRectangle);Invalidate();};
  MouseUp+=(s,e)=>{if(!dragging)return;dragging=false;Capture=false;DialogResult=region.Width>1 && region.Height>1?DialogResult.OK:DialogResult.Cancel;Close();};
 }
 protected override void OnPaint(PaintEventArgs e) {
  e.Graphics.DrawImageUnscaled(desktop,0,0);
  using(var brush=new SolidBrush(Color.FromArgb(95,0,0,0))){e.Graphics.FillRectangle(brush,ClientRectangle);}
  if(region.Width>0 && region.Height>0){e.Graphics.DrawImage(desktop,region,region,GraphicsUnit.Pixel);using(var pen=new Pen(Color.FromArgb(49,94,216),2)){e.Graphics.DrawRectangle(pen,region);}}
 }
}
'@
[SinanSelector]::Run($env:SINAN_CAPTURE_OUTPUT)
`
