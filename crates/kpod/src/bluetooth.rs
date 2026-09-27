//! Paired Bluetooth speakers reported by the Kindle `btfd` LIPC hash lists.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BtDevice {
    pub name: String,
    pub address: String,
    pub connected: bool,
    pub audio: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BtAction {
    Connect(String),
    Disconnect(String),
}

/// Connect the first paired speaker, or disconnect one that is already up.
pub fn next_action(devices: &[BtDevice]) -> Result<BtAction, &'static str> {
    if let Some(dev) = devices.iter().find(|d| d.connected) {
        return Ok(BtAction::Disconnect(dev.address.clone()));
    }
    let Some(dev) = devices.iter().find(|d| d.audio).or_else(|| devices.first()) else {
        return Err("Pair a speaker in Kindle settings first.");
    };
    Ok(BtAction::Connect(dev.address.clone()))
}

/// Parse `lipc-hash-prop` output for `ListPaired` or `ListConnected`.
pub fn parse_device_list(text: &str) -> Vec<BtDevice> {
    let mut devices = Vec::new();
    for block in text.split("Hash Index:") {
        let mut name = String::new();
        let mut address = String::new();
        let mut connected = false;
        let mut audio = false;
        for line in block.lines() {
            let Some((key, value)) = line.trim().split_once('=') else {
                continue;
            };
            let key = key.trim();
            let value = value.trim();
            match key {
                "bd_name" => name = unquote(value),
                "bd_address" => address = unquote(value),
                "is_connected" => connected = value.contains('1'),
                "class_of_device" => audio = unquote(value).to_ascii_lowercase().contains("audio"),
                _ => {}
            }
        }
        if !address.is_empty() {
            if name.is_empty() {
                name = address.clone();
            }
            devices.push(BtDevice {
                name,
                address,
                connected,
                audio,
            });
        }
    }
    devices
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"
Hash Index: 0
	bd_name = "Office speaker"
	bd_address = "F8:0F:F9:B2:CD:17"
	class_of_device = "Audio/Video"
	is_connected = (0)
"#;

    #[test]
    fn parses_a_paired_speaker() {
        let devices = parse_device_list(LIST);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Office speaker");
        assert_eq!(devices[0].address, "F8:0F:F9:B2:CD:17");
        assert!(!devices[0].connected);
        assert!(devices[0].audio);
    }

    #[test]
    fn connects_a_paired_speaker_and_disconnects_a_live_one() {
        let mut devices = parse_device_list(LIST);
        assert_eq!(
            next_action(&devices).unwrap(),
            BtAction::Connect("F8:0F:F9:B2:CD:17".into())
        );
        devices[0].connected = true;
        assert_eq!(
            next_action(&devices).unwrap(),
            BtAction::Disconnect("F8:0F:F9:B2:CD:17".into())
        );
        assert_eq!(
            next_action(&[]).unwrap_err(),
            "Pair a speaker in Kindle settings first."
        );
    }
}
