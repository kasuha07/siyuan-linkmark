# Render Linkmark icons independently of other plugins

Linkmark removes Link Icon-specific settings, detection, style observation, and priority behavior. It ignores retired compatibility preferences when loading and omits them from later saves, while rendering its own selected icon with ordinary CSS declarations rather than `!important`; this keeps the plugin focused on its cache and resolver boundary instead of coupling it to a third-party implementation.
