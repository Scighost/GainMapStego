using ComputeSharp;
using ComputeSharp.D2D1;
using ComputeSharp.D2D1.WinUI;
using GainMapStego.UltraHDR;
using Microsoft.Graphics.Canvas;
using System.Numerics;
using Windows.Graphics.Effects;

namespace GainMapStego.Codec;

public partial class GainMapDecEffect : CanvasEffect
{

    public SrgbGammaMode GammaMode { get; set; }

    public required IGraphicsEffectSource BaseSource { get; set; }

    public required IGraphicsEffectSource GainmapSource { get; set; }

    public UhdrGainmapMetadata GainmapMetadata { get; set; }

    public CanvasBufferPrecision? BufferPrecision { get; set; }


    protected override void BuildEffectGraph(CanvasEffectGraph effectGraph)
    {
        var eotf = new SrgbGammaEffect
        {
            Source = BaseSource,
            GammaMode = SrgbGammaMode.EOTF,
            BufferPrecision = this.BufferPrecision,
        };
        var dec = new PixelShaderEffect<GainMapDecShader>();
        dec.BufferPrecision = this.BufferPrecision;
        dec.ConstantBuffer = new GainMapDecShader(GainmapMetadata);
        dec.Sources[0] = eotf;
        dec.Sources[1] = GainmapSource;
        var oetf = new SrgbGammaEffect
        {
            Source = dec,
            GammaMode = SrgbGammaMode.OETF,
            BufferPrecision = this.BufferPrecision,
        };
        effectGraph.RegisterOutputNode(oetf);
    }

    protected override void ConfigureEffectGraph(CanvasEffectGraph effectGraph)
    {

    }

    [D2DInputCount(2)]
    [D2DInputSimple(0)]
    [D2DShaderProfile(D2D1ShaderProfile.PixelShader50)]
    [D2DGeneratedPixelShaderDescriptor]
    internal readonly partial struct GainMapDecShader : ID2D1PixelShader
    {
        private readonly float3 maxContentBoost;
        private readonly float3 minContentBoost;
        private readonly float3 gamma;
        private readonly float3 offsetSDR;
        private readonly float3 offsetHDR;

        public GainMapDecShader(UhdrGainmapMetadata metadata)
        {
            maxContentBoost = metadata.MaxContentBoost;
            minContentBoost = metadata.MinContentBoost;
            gamma = metadata.Gamma;
            offsetSDR = metadata.OffsetSdr;
            offsetHDR = metadata.OffsetHdr;
        }

        public float4 Execute()
        {
            float4 baseImage = D2D.GetInput(0);
            float4 gainmapImage = D2D.GetInput(1);
            float3 rgb1 = baseImage.RGB;
            float3 rgb2 = gainmapImage.RGB;

            float3 div = Hlsl.Pow(2, Hlsl.Pow(Hlsl.Abs(rgb2), 1 / gamma) * (maxContentBoost - minContentBoost) + minContentBoost);
            float3 hdr = div * (rgb1 + offsetSDR) - offsetHDR;
            return new float4(hdr, baseImage.A);
        }
    }

}




public partial class UhdrPixelLinearRecoveryEffect : CanvasEffect
{

    public required IGraphicsEffectSource SdrSource { get; set; }

    public required IGraphicsEffectSource HdrSource { get; set; }

    public CanvasBufferPrecision? BufferPrecision { get; set; }

    public Vector3 OffsetSdr { get; set; } = new(0.015625f);

    public Vector3 OffsetHdr { get; set; } = new(0.015625f);


    protected override void BuildEffectGraph(CanvasEffectGraph effectGraph)
    {
        PixelShaderEffect<UhdrPixelLinearRecoveryShader> effect = new()
        {
            BufferPrecision = BufferPrecision,
        };
        effect.Sources[0] = SdrSource;
        effect.Sources[1] = HdrSource;
        effect.ConstantBuffer = new UhdrPixelLinearRecoveryShader(OffsetSdr, OffsetHdr);
        effectGraph.RegisterOutputNode(effect);
    }

    protected override void ConfigureEffectGraph(CanvasEffectGraph effectGraph)
    {

    }


    [D2DInputCount(2)]
    [D2DShaderProfile(D2D1ShaderProfile.PixelShader50)]
    [D2DGeneratedPixelShaderDescriptor]
    internal readonly partial struct UhdrPixelLinearRecoveryShader : ID2D1PixelShader
    {

        private readonly float3 offsetSdr;

        private readonly float3 offsetHdr;

        public UhdrPixelLinearRecoveryShader(Vector3 offsetSdr, Vector3 offsetHdr)
        {
            this.offsetSdr = offsetSdr;
            this.offsetHdr = offsetHdr;
        }


        public float4 Execute()
        {
            float4 sdr = D2D.GetInput(0);
            float4 hdr = D2D.GetInput(1);
            float3 gain = (Hlsl.Max(hdr.RGB, 0) + offsetHdr) / (Hlsl.Max(sdr.RGB, 0) + offsetSdr);
            return new float4(gain, sdr.A);
        }

    }

}


public partial class UhdrGainmapEffect : CanvasEffect
{

    public Vector3 MinContentBoost { get; set; }

    public Vector3 MaxContentBoost { get; set; }

    public Vector3 Gamma { get; set; } = Vector3.One;

    public required IGraphicsEffectSource PixelLinearRecoverySource { get; set; }

    public CanvasBufferPrecision? BufferPrecision { get; set; }


    protected override void BuildEffectGraph(CanvasEffectGraph effectGraph)
    {
        PixelShaderEffect<UhdrGainmapShader> effect = new()
        {
            BufferPrecision = BufferPrecision,
        };
        effect.Sources[0] = PixelLinearRecoverySource;
        effect.ConstantBuffer = new UhdrGainmapShader(MinContentBoost, MaxContentBoost, Gamma);
        effectGraph.RegisterOutputNode(effect);
    }

    protected override void ConfigureEffectGraph(CanvasEffectGraph effectGraph)
    {

    }


    [D2DInputCount(1)]
    [D2DShaderProfile(D2D1ShaderProfile.PixelShader50)]
    [D2DGeneratedPixelShaderDescriptor]
    internal readonly partial struct UhdrGainmapShader : ID2D1PixelShader
    {

        private readonly float3 minBoostLog;

        private readonly float3 maxBoostLog;

        private readonly float3 gamma;


        public UhdrGainmapShader(Vector3 minBoostContent, Vector3 maxBoostContent, Vector3 gamma)
        {
            this.minBoostLog = Vector3.Log2(minBoostContent);
            this.maxBoostLog = Vector3.Log2(maxBoostContent);
            this.gamma = gamma;
        }


        public float4 Execute()
        {
            float4 gain = D2D.GetInput(0);
            float3 logRecovery = (Hlsl.Log2(gain.RGB) - minBoostLog) / (maxBoostLog - minBoostLog);
            float3 clampedRecovery = Hlsl.Clamp(logRecovery, 0, 1);
            return new float4(Hlsl.Pow(clampedRecovery, gamma), gain.A);
        }

    }

}














