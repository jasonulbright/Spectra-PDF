//! The sparse package's manifest. Rendered once per architecture by the
//! `render-manifest` example at build time; the registry-free half of the
//! registration, so every extension it lists comes from the one accepted set.

use crate::ids::{self, Verb};

pub const ARCHES: [&str; 2] = ["x64", "arm64"];

/// `1.2.8` → `1.2.8.0`. A package version is four fields below 65536.
pub fn msix_version(app_version: &str) -> Result<String, String> {
    let fields: Vec<&str> = app_version.split('.').collect();
    let numeric = fields.len() == 3
        && fields.iter().all(|f| {
            !f.is_empty()
                && f.bytes().all(|b| b.is_ascii_digit())
                && (f.len() == 1 || !f.starts_with('0'))
                && f.parse::<u32>().is_ok_and(|n| n < 65536)
        });
    if !numeric {
        return Err(format!("app version {app_version} cannot become a package version"));
    }
    Ok(format!("{app_version}.0"))
}

pub fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn render(publisher: &str, app_version: &str, arch: &str) -> Result<String, String> {
    if !ARCHES.contains(&arch) {
        return Err(format!("unknown architecture {arch}"));
    }
    if publisher.trim().is_empty() {
        return Err("the publisher subject is empty".to_string());
    }
    let version = msix_version(app_version)?;
    let dll = format!("shell\\{arch}\\spectrapdf_shell.dll");

    let mut item_types = String::new();
    for extension in ids::registered_extensions() {
        item_types.push_str(&format!(
            "            <desktop5:ItemType Type=\".{extension}\">\n"
        ));
        for verb in Verb::ALL {
            if verb.accepts_extension(extension) {
                item_types.push_str(&format!(
                    "              <desktop5:Verb Id=\"{}\" Clsid=\"{}\" />\n",
                    verb.package_verb_id(),
                    verb.clsid()
                ));
            }
        }
        item_types.push_str("            </desktop5:ItemType>\n");
    }
    let classes: String = Verb::ALL
        .iter()
        .map(|verb| {
            format!(
                "              <com:Class Id=\"{}\" Path=\"{dll}\" ThreadingModel=\"STA\" />\n",
                verb.clsid()
            )
        })
        .collect();

    Ok(format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4"
  xmlns:desktop5="http://schemas.microsoft.com/appx/manifest/desktop/windows10/5"
  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
  xmlns:com="http://schemas.microsoft.com/appx/manifest/com/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 desktop4 desktop5 desktop6 com rescap">
  <Identity Name="{name}" Publisher="{publisher}" Version="{version}" ProcessorArchitecture="{arch}" />
  <Properties>
    <DisplayName>{display}</DisplayName>
    <PublisherDisplayName>{display}</PublisherDisplayName>
    <Logo>shell\StoreLogo.png</Logo>
    <uap10:AllowExternalContent>true</uap10:AllowExternalContent>
    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
    <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>
  <Applications>
    <Application Id="SpectraPDF" Executable="spectrapdf.exe" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
      <uap:VisualElements AppListEntry="none" DisplayName="{display}" Description="{display}" BackgroundColor="transparent" Square150x150Logo="shell\Square150x150Logo.png" Square44x44Logo="shell\Square44x44Logo.png" />
      <Extensions>
        <desktop4:Extension Category="windows.fileExplorerContextMenus">
          <desktop4:FileExplorerContextMenus>
{item_types}          </desktop4:FileExplorerContextMenus>
        </desktop4:Extension>
        <com:Extension Category="windows.comServer">
          <com:ComServer>
            <com:SurrogateServer DisplayName="{display}">
{classes}            </com:SurrogateServer>
          </com:ComServer>
        </com:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
"#,
        name = ids::PACKAGE_NAME,
        publisher = xml_escape(publisher),
        display = xml_escape(ids::PACKAGE_DISPLAY_NAME),
    ))
}

/// The identity file the app reads back to name the package it registers.
pub fn identity_json(publisher: &str, app_version: &str) -> Result<String, String> {
    let version = msix_version(app_version)?;
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "name": ids::PACKAGE_NAME,
        "publisher": publisher,
        "version": version,
    }))
    .expect("a json object serializes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLISHER: &str = "CN=Jason Ulbright, O=Jason Ulbright, L=Apex, S=nc, C=US";

    #[test]
    fn every_offered_extension_is_an_item_type_and_postscript_is_not() {
        let xml = render(PUBLISHER, "1.2.8", "x64").unwrap();
        for ext in crate::create_pdf_sources::IMAGES
            .iter()
            .chain(crate::create_pdf_sources::OFFICE)
            .chain(["pdf"].iter())
        {
            assert_eq!(xml.matches(&format!("Type=\".{ext}\"")).count(), 1, "{ext}");
        }
        for ext in crate::create_pdf_sources::POSTSCRIPT {
            assert!(!xml.contains(&format!("Type=\".{ext}\"")), "{ext}");
        }
        let pdf = xml.split("Type=\".pdf\"").nth(1).unwrap();
        let pdf = pdf.split("</desktop5:ItemType>").next().unwrap();
        assert!(pdf.contains(Verb::Combine.clsid()));
        assert!(!pdf.contains(Verb::Convert.clsid()));
    }

    #[test]
    fn the_classes_name_the_fixed_clsids_and_the_architectures_dll() {
        let xml = render(PUBLISHER, "1.2.8", "arm64").unwrap();
        for verb in Verb::ALL {
            assert!(xml.contains(&format!(
                "<com:Class Id=\"{}\" Path=\"shell\\arm64\\spectrapdf_shell.dll\" ThreadingModel=\"STA\" />",
                verb.clsid()
            )));
        }
        assert_eq!(Verb::Convert.clsid(), "9A90E15E-F7FA-4166-A6A4-DD16727F4DD1");
        assert_eq!(Verb::Combine.clsid(), "1E6E88CC-5B6A-4904-BFB0-DACAD020EA49");
        assert!(xml.contains("ProcessorArchitecture=\"arm64\""));
        assert!(xml.contains("<uap10:AllowExternalContent>true</uap10:AllowExternalContent>"));
        assert!(xml.contains("AppListEntry=\"none\""));
        assert!(xml.contains("<desktop5:Verb Id=\"SpectraPDFCombine\""));
        assert!(render(PUBLISHER, "1.2.8", "x86").is_err());
    }

    #[test]
    fn the_package_version_appends_a_zero_field() {
        assert_eq!(msix_version("1.2.8").unwrap(), "1.2.8.0");
        assert_eq!(msix_version("2026.1004.151").unwrap(), "2026.1004.151.0");
        for bad in ["1.2", "1.2.8.0", "1.02.3", "1.2.65536", "1.2.x", "1.2.8-rc1", ""] {
            assert!(msix_version(bad).is_err(), "{bad}");
        }
        let xml = render(PUBLISHER, "2026.930.150", "x64").unwrap();
        assert!(xml.contains("Version=\"2026.930.150.0\""));
    }

    #[test]
    fn the_publisher_is_escaped_into_the_attribute() {
        let xml = render("CN=\"A & B\" <x>, O='Q'", "1.2.8", "x64").unwrap();
        assert!(xml.contains("Publisher=\"CN=&quot;A &amp; B&quot; &lt;x&gt;, O=&apos;Q&apos;\""));
        assert!(render("  ", "1.2.8", "x64").is_err());
        let identity: serde_json::Value =
            serde_json::from_str(&identity_json(PUBLISHER, "1.2.8").unwrap()).unwrap();
        assert_eq!(identity["publisher"], PUBLISHER);
        assert_eq!(identity["version"], "1.2.8.0");
        assert_eq!(identity["name"], ids::PACKAGE_NAME);
    }
}
