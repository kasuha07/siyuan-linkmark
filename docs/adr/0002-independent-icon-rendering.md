# Render Auto Favicon icons independently of other plugins

Auto Favicon will remove Link Icon-specific settings, detection, style observation, and priority behavior. It will ignore retired compatibility preferences when loading and omit them from later saves, while rendering its own selected icon with ordinary CSS declarations rather than `!important`; this keeps the plugin focused on its cache and resolver boundary instead of coupling it to a third-party implementation.
